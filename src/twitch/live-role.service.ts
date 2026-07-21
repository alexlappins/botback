import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from 'discord.js';

import { PremiumService } from '../premium/premium.service';
import { LiveRoleBinding, LiveRoleConfig } from './entities/twitch-features.entities';
import { TwitchEventDispatcher } from './twitch-event-dispatcher.service';
import { TwitchHelixService, TwitchStream } from './twitch-helix.service';

export const LIVE_ROLE_FREE_BINDINGS = 5;
export const LIVE_ROLE_PREMIUM_CONFIGS = 5;

/**
 * Live Role (TZ-A §2): a member gets a role while their Twitch channel is
 * live. Realtime path: EventSub stream.online/offline via the dispatcher.
 * Safety net + restart reconciliation (§2.3): a 5-minute Helix sweep over all
 * bindings — also the only path for manually-bound channels that aren't in
 * the EventSub set (live status via app token, no OAuth needed §2.2b).
 */
@Injectable()
export class LiveRoleService implements OnModuleInit {
  private readonly logger = new Logger(LiveRoleService.name);

  constructor(
    @InjectRepository(LiveRoleConfig)
    private readonly configRepo: Repository<LiveRoleConfig>,
    @InjectRepository(LiveRoleBinding)
    private readonly bindingRepo: Repository<LiveRoleBinding>,
    private readonly dispatcher: TwitchEventDispatcher,
    private readonly helix: TwitchHelixService,
    private readonly premium: PremiumService,
    @Inject(Client) private readonly discord: Client,
  ) {}

  onModuleInit(): void {
    this.dispatcher.on('stream.online', (event) =>
      this.sweepTwitchUser(String(event.broadcaster_user_id ?? '')),
    );
    this.dispatcher.on('stream.offline', (event) =>
      this.sweepTwitchUser(String(event.broadcaster_user_id ?? '')),
    );
  }

  // ── CRUD (used by controller) ───────────────────────────

  listConfigs(guildId: string): Promise<LiveRoleConfig[]> {
    return this.configRepo.find({ where: { guildId }, order: { createdAt: 'ASC' } });
  }

  listBindings(guildId: string): Promise<LiveRoleBinding[]> {
    return this.bindingRepo.find({ where: { guildId }, order: { createdAt: 'ASC' } });
  }

  async createConfig(guildId: string, roleId: string): Promise<LiveRoleConfig> {
    const existing = await this.configRepo.count({ where: { guildId } });
    const isPremium = await this.premium.isPremium(guildId);
    const limit = isPremium ? LIVE_ROLE_PREMIUM_CONFIGS : 1; // §2.4
    if (existing >= limit) {
      throw new Error(isPremium ? `Maximum ${limit} Live Role configurations` : 'premium_required');
    }
    return this.configRepo.save(this.configRepo.create({ guildId, roleId }));
  }

  async updateConfig(guildId: string, id: string, patch: Partial<LiveRoleConfig>): Promise<LiveRoleConfig> {
    const row = await this.configRepo.findOneOrFail({ where: { id, guildId } });
    const isPremium = await this.premium.isPremium(guildId);
    if (!isPremium) {
      // Filters/blacklist are premium-only (§2.4) — silently drop on free.
      delete patch.filterText;
      delete patch.blacklist;
    }
    Object.assign(row, patch, { id, guildId });
    return this.configRepo.save(row);
  }

  async deleteConfig(guildId: string, id: string): Promise<void> {
    await this.bindingRepo.delete({ guildId, configId: id });
    await this.configRepo.delete({ id, guildId });
  }

  async addBinding(
    guildId: string,
    configId: string,
    discordUserId: string,
    twitchLogin: string,
    source: 'auto' | 'manual',
  ): Promise<LiveRoleBinding> {
    const isPremium = await this.premium.isPremium(guildId);
    if (!isPremium) {
      const count = await this.bindingRepo.count({ where: { guildId } });
      if (count >= LIVE_ROLE_FREE_BINDINGS) throw new Error('premium_required'); // §2.4
    }
    const [user] = await this.helix.getUsersByLogin([twitchLogin]);
    if (!user) throw new Error(`Twitch channel "${twitchLogin}" not found`);
    let row = await this.bindingRepo.findOne({ where: { guildId, configId, twitchUserId: user.id } });
    if (!row) row = this.bindingRepo.create({ guildId, configId, twitchUserId: user.id });
    row.discordUserId = discordUserId;
    row.twitchLogin = user.login;
    row.source = source;
    return this.bindingRepo.save(row);
  }

  async removeBinding(guildId: string, id: string): Promise<void> {
    const row = await this.bindingRepo.findOne({ where: { id, guildId } });
    if (row?.isLive) await this.setRole(row, false).catch(() => null);
    await this.bindingRepo.delete({ id, guildId });
  }

  // ── Live status sync ────────────────────────────────────

  /** Fast path from EventSub — sweep just one broadcaster. */
  private async sweepTwitchUser(twitchUserId: string): Promise<void> {
    if (!twitchUserId) return;
    const bindings = await this.bindingRepo.find({ where: { twitchUserId } });
    if (!bindings.length) return;
    const [stream] = await this.helix.getStreamsByUserIds([twitchUserId]).catch(() => []);
    await this.applyLiveState(bindings, stream ? new Map([[twitchUserId, stream]]) : new Map());
  }

  /** §2.3 reconciliation: full sweep every 5 minutes (also covers restarts). */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'twitch.live_role_reconcile' })
  async reconcile(): Promise<void> {
    const bindings = await this.bindingRepo.find();
    if (!bindings.length) return;
    const ids = [...new Set(bindings.map((b) => b.twitchUserId))];
    const liveMap = new Map<string, TwitchStream>();
    for (let i = 0; i < ids.length; i += 100) {
      const streams = await this.helix.getStreamsByUserIds(ids.slice(i, i + 100)).catch(() => []);
      for (const s of streams) liveMap.set(s.user_id, s);
    }
    await this.applyLiveState(bindings, liveMap);
  }

  private async applyLiveState(bindings: LiveRoleBinding[], liveMap: Map<string, TwitchStream>): Promise<void> {
    const configs = new Map<string, LiveRoleConfig>();
    for (const b of bindings) {
      let cfg = configs.get(b.configId) ?? null;
      if (!cfg) {
        cfg = await this.configRepo.findOne({ where: { id: b.configId } });
        if (cfg) configs.set(cfg.id, cfg);
      }
      if (!cfg?.enabled) continue;

      const stream = liveMap.get(b.twitchUserId) ?? null;
      let shouldHave = Boolean(stream);
      // §2.4 premium filter: game/title contains X.
      if (shouldHave && cfg.filterText?.trim() && (await this.premium.isPremium(b.guildId))) {
        const needle = cfg.filterText.trim().toLowerCase();
        shouldHave =
          (stream!.game_name ?? '').toLowerCase().includes(needle) ||
          (stream!.title ?? '').toLowerCase().includes(needle);
      }
      if (cfg.blacklist.includes(b.discordUserId)) shouldHave = false;

      if (shouldHave === b.isLive) continue;
      const ok = await this.setRole(b, shouldHave, cfg.roleId);
      if (ok) {
        b.isLive = shouldHave;
        await this.bindingRepo.save(b);
      }
    }
  }

  private async setRole(binding: LiveRoleBinding, give: boolean, roleId?: string): Promise<boolean> {
    try {
      const guild = this.discord.guilds.cache.get(binding.guildId);
      if (!guild) return false;
      const rid = roleId ?? (await this.configRepo.findOne({ where: { id: binding.configId } }))?.roleId;
      if (!rid || !guild.roles.cache.has(rid)) return false;
      const member = await guild.members.fetch(binding.discordUserId).catch(() => null);
      if (!member) return false;
      if (give) await member.roles.add(rid, 'Live Role: stream online');
      else await member.roles.remove(rid, 'Live Role: stream offline');
      return true;
    } catch (e) {
      // §2.5 — hierarchy problems must not crash; the UI shows a warning.
      this.logger.debug(`live role toggle failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** §2.5 — UI warning helper. */
  hierarchyWarning(guildId: string, roleId: string): boolean {
    const guild = this.discord.guilds.cache.get(guildId);
    const role = guild?.roles.cache.get(roleId);
    const me = guild?.members.me;
    return Boolean(role && me && role.position >= me.roles.highest.position);
  }
}
