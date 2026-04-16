import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, EmbedBuilder } from 'discord.js';
import { GuildStorageService } from '../common/storage/guild-storage.service';

function emojiToKey(emoji: string): string {
  const trimmed = emoji.trim();
  const customMatch = trimmed.match(/:(\d+)>?$/);
  if (customMatch) return customMatch[1];
  if (trimmed.includes(':')) {
    const part = trimmed.split(':').pop();
    if (part && /^\d+$/.test(part)) return part;
  }
  return trimmed;
}

const DISCORD_API = 'https://discord.com/api/v10';
const GUILDS_CACHE_TTL_MS = 60_000; // 1 минута

/** Права: ADMINISTRATOR (0x8) или MANAGE_GUILD (0x20) */
const CAN_MANAGE_GUILD = 0x8 | 0x20;

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  permissions: string;
  owner: boolean;
}

/** Результат рефреша токена, возвращается вызывающей стороне для обновления сессии */
export interface TokenRefreshResult {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class GuildsService {
  private readonly guildsCache = new Map<string, { guilds: DiscordGuild[]; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<DiscordGuild[]>>();
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly storage: GuildStorageService,
    config: ConfigService,
  ) {
    this.clientId = config.getOrThrow<string>('DISCORD_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('DISCORD_CLIENT_SECRET');
  }

  /**
   * Получить серверы пользователя. Если accessToken протух и есть refreshToken —
   * автоматически обновляет токен. Новые токены возвращаются в `onTokenRefresh`,
   * чтобы контроллер мог обновить сессию.
   */
  async getUserGuilds(
    accessToken: string,
    refreshToken?: string,
    onTokenRefresh?: (tokens: TokenRefreshResult) => void,
    forceRefresh = false,
  ): Promise<DiscordGuild[]> {
    const key = createHash('sha256').update(accessToken).digest('hex');

    if (forceRefresh) {
      this.guildsCache.delete(key);
    }

    const cached = this.guildsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.guilds;

    let promise = this.inFlight.get(key);
    if (promise) return promise;

    promise = this.fetchUserGuilds(accessToken, refreshToken, onTokenRefresh);
    this.inFlight.set(key, promise);
    try {
      const guilds = await promise;
      this.guildsCache.set(key, { guilds, expiresAt: Date.now() + GUILDS_CACHE_TTL_MS });
      return guilds;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchUserGuilds(
    accessToken: string,
    refreshToken?: string,
    onTokenRefresh?: (tokens: TokenRefreshResult) => void,
    retriesLeft = 5,
  ): Promise<DiscordGuild[]> {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 429 && retriesLeft > 0) {
      const data = (await res.json()) as { retry_after?: number };
      const waitMs = Math.ceil((data.retry_after ?? 1) * 1000) + 50;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.fetchUserGuilds(accessToken, refreshToken, onTokenRefresh, retriesLeft - 1);
    }

    // Токен протух — пробуем обновить через refresh_token
    if (res.status === 401 && refreshToken) {
      const newTokens = await this.refreshAccessToken(refreshToken);
      if (newTokens) {
        onTokenRefresh?.(newTokens);
        return this.fetchUserGuilds(newTokens.accessToken, newTokens.refreshToken, onTokenRefresh, 0);
      }
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`Discord API /users/@me/guilds: ${res.status}`, body);
      throw new Error(`Failed to fetch guilds: ${res.status} ${body.slice(0, 200)}`);
    }

    const guilds = (await res.json()) as Array<{
      id: string;
      name: string;
      icon: string | null;
      permissions: string;
      owner: boolean;
    }>;
    console.log(`[GuildsService] Discord вернул ${guilds.length} серверов пользователя`);

    const botGuildIds = new Set(this.client.guilds.cache.map((g) => g.id));
    console.log(`[GuildsService] Бот сейчас на ${botGuildIds.size} серверах:`, [...botGuildIds]);

    const result: DiscordGuild[] = [];
    for (const g of guilds) {
      const hasPermission = g.owner || (BigInt(g.permissions || '0') & BigInt(CAN_MANAGE_GUILD)) !== 0n;

      let botInGuild = this.client.guilds.cache.has(g.id);
      if (!botInGuild) {
        botInGuild = await this.client.guilds
          .fetch(g.id)
          .then(() => true)
          .catch(() => false);
      }

      console.log(
        `[GuildsService]   ${g.name} (${g.id}): owner=${g.owner}, perm=${hasPermission}, bot=${botInGuild}`,
      );

      if (!hasPermission) continue;
      if (botInGuild) result.push(g);
    }
    console.log(`[GuildsService] Итого подходит: ${result.length}`);
    return result;
  }

  private async refreshAccessToken(refreshToken: string): Promise<TokenRefreshResult | null> {
    try {
      const res = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.clientId,
          client_secret: this.clientSecret,
        }),
      });
      if (!res.ok) {
        console.error('Discord token refresh failed:', res.status, await res.text());
        return null;
      }
      const data = (await res.json()) as {
        access_token: string;
        refresh_token: string;
      };
      return { accessToken: data.access_token, refreshToken: data.refresh_token };
    } catch (e) {
      console.error('Discord token refresh error:', e);
      return null;
    }
  }

  getGuildChannels(guildId: string): Array<{ id: string; name: string; type: number }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return guild.channels.cache
      .filter((ch) => ch.isTextBased() && !ch.isDMBased())
      .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }));
  }

  getGuildRoles(guildId: string): Array<{ id: string; name: string }> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) return [];
    return guild.roles.cache
      .filter((r) => !r.managed && r.id !== guild.id) // без интеграций и без @everyone
      .map((r) => ({ id: r.id, name: r.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async addReactionRoleBinding(
    guildId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    roleId: string,
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) throw new Error('Channel not found or not text channel');
    const message = await (channel as import('discord.js').TextChannel).messages.fetch(messageId);
    await message.react(emoji.trim());
    const emojiKey = emojiToKey(emoji);
    this.storage.setReactionRoleBinding(guildId, message.id, emojiKey, roleId);
    this.storage.setReactionRoleChannel(guildId, message.id, channelId);
  }

  async sendMessage(
    guildId: string,
    channelId: string,
    payload: { title?: string; description?: string; image?: string },
  ): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Guild not found');
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) throw new Error('Channel not found or not text channel');
    const embed = new EmbedBuilder().setColor(0x5865f2);
    if (payload.title) embed.setTitle(payload.title);
    if (payload.description) embed.setDescription(payload.description);
    if (payload.image) {
      try {
        new URL(payload.image);
        embed.setImage(payload.image);
      } catch {
        // ignore invalid URL
      }
    }
    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }
}
