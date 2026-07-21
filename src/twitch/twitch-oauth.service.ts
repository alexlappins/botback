import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from 'discord.js';
import { createHmac } from 'crypto';

import { TwitchConnection, ViewerLink } from './entities/twitch-features.entities';
import { decryptToken, encryptToken } from './token-crypto';
import { LevelingService } from '../leveling/leveling.service';

/** TZ-A §1.1 — streamer scopes (chatters requested up-front for TZ-B). */
export const STREAMER_SCOPES = [
  'channel:read:subscriptions',
  'bits:read',
  'moderator:read:followers',
  'moderator:read:chatters',
];

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  scope?: string[];
  expires_in: number;
}

/**
 * Twitch OAuth as "account connection" inside the dashboard (TZ-A §1) —
 * NEVER a login method (§0.2); dashboard auth stays Discord-only.
 * Tokens are AES-encrypted at rest; refresh is automatic; a failed refresh
 * marks the connection revoked, silently stops dependent features and DMs
 * the guild owner once (§1.3).
 */
@Injectable()
export class TwitchOAuthService {
  private readonly logger = new Logger(TwitchOAuthService.name);

  constructor(
    @InjectRepository(TwitchConnection)
    private readonly connRepo: Repository<TwitchConnection>,
    @InjectRepository(ViewerLink)
    private readonly viewerRepo: Repository<ViewerLink>,
    private readonly config: ConfigService,
    private readonly leveling: LevelingService,
    @Inject(Client) private readonly discord: Client,
  ) {
    // /rank hint (TZ-B §2.6) needs to know link status without a module cycle.
    this.leveling.isViewerLinked = async (discordUserId) =>
      Boolean(await this.viewerRepo.findOne({ where: { discordUserId } }));
  }

  private clientId(): string {
    return this.config.getOrThrow<string>('TWITCH_CLIENT_ID');
  }
  private clientSecret(): string {
    return this.config.getOrThrow<string>('TWITCH_CLIENT_SECRET');
  }
  private redirectUri(kind: 'streamer' | 'viewer'): string {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') ?? '').replace(/\/$/, '');
    return `${base}/api/twitch/oauth/${kind === 'streamer' ? 'callback' : 'viewer-callback'}`;
  }

  /** Signed state so the callback can't be forged cross-guild. */
  signState(payload: string): string {
    const sig = createHmac('sha256', this.clientSecret()).update(payload).digest('hex').slice(0, 16);
    return `${Buffer.from(payload).toString('base64url')}.${sig}`;
  }
  verifyState(state: string): string | null {
    const [b64, sig] = state.split('.');
    if (!b64 || !sig) return null;
    const payload = Buffer.from(b64, 'base64url').toString();
    const expected = createHmac('sha256', this.clientSecret()).update(payload).digest('hex').slice(0, 16);
    return sig === expected ? payload : null;
  }

  authorizeUrl(kind: 'streamer' | 'viewer', state: string): string {
    const qs = new URLSearchParams({
      client_id: this.clientId(),
      redirect_uri: this.redirectUri(kind),
      response_type: 'code',
      scope: kind === 'streamer' ? STREAMER_SCOPES.join(' ') : '',
      state,
      force_verify: 'true',
    });
    return `https://id.twitch.tv/oauth2/authorize?${qs}`;
  }

  private async exchangeCode(code: string, kind: 'streamer' | 'viewer'): Promise<TokenResponse> {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId(),
        client_secret: this.clientSecret(),
        code,
        grant_type: 'authorization_code',
        redirect_uri: this.redirectUri(kind),
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as TokenResponse;
  }

  private async fetchSelf(accessToken: string): Promise<{ id: string; login: string }> {
    const res = await fetch('https://api.twitch.tv/helix/users', {
      headers: { 'Client-Id': this.clientId(), Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Get self failed: ${res.status}`);
    const data = (await res.json()) as { data: { id: string; login: string }[] };
    if (!data.data[0]) throw new Error('Twitch returned no user');
    return data.data[0];
  }

  // ── Streamer connections (§1) ───────────────────────────

  async completeStreamerConnect(guildId: string, discordUserId: string, code: string): Promise<TwitchConnection> {
    const tokens = await this.exchangeCode(code, 'streamer');
    const self = await this.fetchSelf(tokens.access_token);

    let row = await this.connRepo.findOne({ where: { guildId, twitchUserId: self.id } });
    if (!row) row = this.connRepo.create({ guildId, twitchUserId: self.id });
    row.discordUserId = discordUserId;
    row.twitchLogin = self.login;
    row.accessTokenEnc = encryptToken(tokens.access_token);
    row.refreshTokenEnc = encryptToken(tokens.refresh_token);
    row.scopes = tokens.scope ?? STREAMER_SCOPES;
    row.status = 'active';
    return this.connRepo.save(row);
  }

  listConnections(guildId: string): Promise<TwitchConnection[]> {
    return this.connRepo.find({ where: { guildId }, order: { createdAt: 'ASC' } });
  }

  async disconnect(guildId: string, connectionId: string): Promise<void> {
    await this.connRepo.delete({ id: connectionId, guildId });
  }

  activeConnections(): Promise<TwitchConnection[]> {
    return this.connRepo.find({ where: { status: 'active' } });
  }

  /**
   * §1.3 — valid access token for a connection, refreshing when needed.
   * On refresh failure → status=revoked + one-time owner DM; returns null.
   */
  async getStreamerToken(conn: TwitchConnection): Promise<string | null> {
    if (conn.status !== 'active') return null;
    const access = decryptToken(conn.accessTokenEnc);

    // Validate cheaply; Twitch recommends hourly validation, we do it per use.
    const check = await fetch('https://id.twitch.tv/oauth2/validate', {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (check.ok) return access;

    // Refresh
    try {
      const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId(),
          client_secret: this.clientSecret(),
          grant_type: 'refresh_token',
          refresh_token: decryptToken(conn.refreshTokenEnc),
        }),
      });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      const tokens = (await res.json()) as TokenResponse;
      conn.accessTokenEnc = encryptToken(tokens.access_token);
      if (tokens.refresh_token) conn.refreshTokenEnc = encryptToken(tokens.refresh_token);
      conn.status = 'active';
      await this.connRepo.save(conn);
      return tokens.access_token;
    } catch (e) {
      this.logger.warn(`Refresh failed for ${conn.twitchLogin} (${conn.guildId}): ${(e as Error).message}`);
      conn.status = 'revoked';
      await this.connRepo.save(conn);
      await this.notifyOwnerRevoked(conn).catch(() => null);
      return null;
    }
  }

  private async notifyOwnerRevoked(conn: TwitchConnection): Promise<void> {
    const guild = this.discord.guilds.cache.get(conn.guildId);
    if (!guild) return;
    const owner = await this.discord.users.fetch(guild.ownerId).catch(() => null);
    await owner?.send(
      `⚠️ Twitch connection for **${conn.twitchLogin}** on **${guild.name}** was revoked or expired. ` +
        `Event alerts and Watch Time XP for this channel are paused — reconnect it in the dashboard (Twitch → Connect).`,
    );
  }

  // ── Viewer links (TZ-B §2.2, identity only) ─────────────

  async completeViewerLink(discordUserId: string, code: string): Promise<ViewerLink> {
    const tokens = await this.exchangeCode(code, 'viewer');
    const self = await this.fetchSelf(tokens.access_token);
    // Identity only — tokens are NOT stored for viewers.
    let row = await this.viewerRepo.findOne({ where: { discordUserId } });
    if (!row) row = this.viewerRepo.create({ discordUserId });
    row.twitchUserId = self.id;
    row.twitchLogin = self.login;
    return this.viewerRepo.save(row);
  }

  getViewerLink(discordUserId: string): Promise<ViewerLink | null> {
    return this.viewerRepo.findOne({ where: { discordUserId } });
  }

  async unlinkViewer(discordUserId: string): Promise<void> {
    await this.viewerRepo.delete({ discordUserId });
  }

  viewerLinksByTwitchIds(twitchIds: string[]): Promise<ViewerLink[]> {
    if (!twitchIds.length) return Promise.resolve([]);
    return this.viewerRepo
      .createQueryBuilder('v')
      .where('v.twitch_user_id IN (:...ids)', { ids: twitchIds })
      .getMany();
  }
}
