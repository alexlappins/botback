import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Client, type Guild, type GuildMember } from 'discord.js';
import { In, Repository } from 'typeorm';

import { FeatureFlagsService } from '../common/feature-flags/feature-flags.service';
import { BotPersonalizationService } from '../personalization/bot-personalization.service';
import { PremiumService } from '../premium/premium.service';
import { RankCardCacheService } from './rank-card-cache.service';
import { RankCardRendererService, buildRankCardData } from './rank-card-renderer.service';
import { IgnoredUser } from './entities/ignored-user.entity';
import { NoXpChannel } from './entities/no-xp-channel.entity';
import { NoXpRole } from './entities/no-xp-role.entity';
import { RoleReward } from './entities/role-reward.entity';
import { ServerLevelingSettings } from './entities/server-leveling-settings.entity';
import { ServerTier } from './entities/server-tier.entity';
import { UserXp } from './entities/user-xp.entity';
import { XpEventLog } from './entities/xp-event-log.entity';
import { levelFromTotalXp, MAX_LEVEL, xpToReachLevel } from './level-formula';
import { renderLevelupMessage } from './notification-renderer';

export interface AwardXpResult {
  awarded: number;
  newTotal: bigint;
  oldLevel: number;
  newLevel: number;
  oldTier: ServerTier | null;
  newTier: ServerTier | null;
  leveledUp: boolean;
  tierChanged: boolean;
}

export type XpEventType = XpEventLog['eventType'];

const DEFAULT_TIERS = [
  { name: 'Newbie', emoji: '🌱', startLevel: 1, endLevel: 5, color: '#94a3b8' },
  { name: 'Regular', emoji: '⭐', startLevel: 6, endLevel: 15, color: '#60a5fa' },
  { name: 'Active', emoji: '🔥', startLevel: 16, endLevel: 30, color: '#22d3ee' },
  { name: 'Veteran', emoji: '⚔️', startLevel: 31, endLevel: 50, color: '#a78bfa' },
  { name: 'Elite', emoji: '💎', startLevel: 51, endLevel: 75, color: '#f472b6' },
  { name: 'Legend', emoji: '🏆', startLevel: 76, endLevel: 100, color: '#facc15' },
  { name: 'Mythic', emoji: '🌌', startLevel: 101, endLevel: 9999, color: '#f97316' },
];

@Injectable()
export class LevelingService {
  private readonly logger = new Logger(LevelingService.name);

  constructor(
    @Inject(Client) private readonly client: Client,
    @InjectRepository(ServerLevelingSettings)
    private readonly settingsRepo: Repository<ServerLevelingSettings>,
    @InjectRepository(ServerTier)
    private readonly tierRepo: Repository<ServerTier>,
    @InjectRepository(UserXp)
    private readonly xpRepo: Repository<UserXp>,
    @InjectRepository(RoleReward)
    private readonly rewardRepo: Repository<RoleReward>,
    @InjectRepository(NoXpRole)
    private readonly noXpRoleRepo: Repository<NoXpRole>,
    @InjectRepository(NoXpChannel)
    private readonly noXpChannelRepo: Repository<NoXpChannel>,
    @InjectRepository(IgnoredUser)
    private readonly ignoredRepo: Repository<IgnoredUser>,
    @InjectRepository(XpEventLog)
    private readonly logRepo: Repository<XpEventLog>,
    private readonly featureFlags: FeatureFlagsService,
    private readonly rankCardCache: RankCardCacheService,
    private readonly rankCardRenderer: RankCardRendererService,
    private readonly premium: PremiumService,
    private readonly personalization: BotPersonalizationService,
  ) {}

  /**
   * Render the rank card PNG for a (server, member) — pulls XP + tier + rank,
   * uses the rendered-card cache, and falls back to null on canvas errors.
   * Called by /rank, the dashboard test-card endpoint, and any other place
   * that needs the user's card with current persisted state.
   */
  async renderRankCard(args: {
    serverId: string;
    memberId: string;
    username: string;
    avatarUrl: string;
  }): Promise<Buffer | null> {
    const cached = this.rankCardCache.get(args.serverId, args.memberId);
    if (cached) return cached;

    const xp = await this.getOrCreateXp(args.serverId, args.memberId);
    const tiers = await this.getTiers(args.serverId);
    const tier = this.resolveTier(tiers, xp.level);
    const rank = await this.rankPosition(args.serverId, args.memberId, 'all');
    const totalMembers = await this.xpRepo.count({ where: { serverId: args.serverId } });
    const settings = await this.getSettings(args.serverId);

    const png = await this.rankCardRenderer.render(
      buildRankCardData({
        username: args.username,
        avatarUrl: args.avatarUrl,
        level: xp.level,
        totalXp: BigInt(xp.totalXp),
        rank,
        totalMembers,
        messagesCount: Number(xp.messagesCount),
        voiceMinutes: Number(xp.voiceMinutes),
        tier,
      }),
      settings,
    );
    if (png) this.rankCardCache.put(args.serverId, args.memberId, png);
    return png;
  }

  // ── Settings / tiers (auto-seed on first read) ─────────

  async getSettings(serverId: string): Promise<ServerLevelingSettings> {
    let s = await this.settingsRepo.findOne({ where: { serverId } });
    if (!s) {
      s = this.settingsRepo.create({ serverId });
      s = await this.settingsRepo.save(s);
      await this.seedDefaultTiersIfMissing(serverId);
    }
    return s;
  }

  async getTiers(serverId: string): Promise<ServerTier[]> {
    let tiers = await this.tierRepo.find({ where: { serverId } });
    if (!tiers.length) {
      await this.seedDefaultTiersIfMissing(serverId);
      tiers = await this.tierRepo.find({ where: { serverId } });
    }
    return tiers.sort((a, b) => a.startLevel - b.startLevel);
  }

  private async seedDefaultTiersIfMissing(serverId: string): Promise<void> {
    const existing = await this.tierRepo.count({ where: { serverId } });
    if (existing > 0) return;
    const rows = DEFAULT_TIERS.map((t, i) =>
      this.tierRepo.create({
        serverId,
        name: t.name,
        emoji: t.emoji,
        startLevel: t.startLevel,
        endLevel: t.endLevel,
        color: t.color,
        sortOrder: i,
      }),
    );
    await this.tierRepo.save(rows);
  }

  resolveTier(tiers: ServerTier[], level: number): ServerTier | null {
    for (const t of tiers) {
      if (level >= t.startLevel && level <= t.endLevel) return t;
    }
    return null;
  }

  // ── Per-user state ─────────────────────────────────────

  async getOrCreateXp(serverId: string, discordId: string): Promise<UserXp> {
    let row = await this.xpRepo.findOne({ where: { serverId, discordId } });
    if (!row) {
      row = this.xpRepo.create({ serverId, discordId });
      try {
        row = await this.xpRepo.save(row);
      } catch {
        row = (await this.xpRepo.findOne({ where: { serverId, discordId } }))!;
      }
    }
    return row;
  }

  async isIgnored(serverId: string, discordId: string): Promise<boolean> {
    return (await this.ignoredRepo.count({ where: { serverId, discordId } })) > 0;
  }

  async hasNoXpRole(member: GuildMember): Promise<boolean> {
    if (!member?.roles?.cache?.size) return false;
    const noRoles = await this.noXpRoleRepo.find({ where: { serverId: member.guild.id } });
    if (!noRoles.length) return false;
    const blocked = new Set(noRoles.map((r) => r.roleId));
    return member.roles.cache.some((r) => blocked.has(r.id));
  }

  async getNoXpChannelIds(serverId: string, type: 'text' | 'voice'): Promise<Set<string>> {
    const rows = await this.noXpChannelRepo.find({ where: { serverId, channelType: type } });
    return new Set(rows.map((r) => r.channelId));
  }

  // ── Core: award XP (called by chat & voice paths) ──────

  /**
   * Award XP and persist new totals/level. Caller is responsible for cooldown
   * and all "should we award?" checks — this method just does the bookkeeping.
   * Returns details the caller uses to fire notifications and role rewards.
   */
  async awardXp(
    serverId: string,
    discordId: string,
    amount: number,
    eventType: XpEventType,
    opts: { updateMessageCounter?: boolean; updateVoiceMinutes?: number } = {},
  ): Promise<AwardXpResult> {
    const row = await this.getOrCreateXp(serverId, discordId);
    const oldTotal = BigInt(row.totalXp);
    const oldLevel = row.level;
    const newTotalRaw = oldTotal + BigInt(amount);
    const newTotal = newTotalRaw < 0n ? 0n : newTotalRaw;
    const newLevel = Math.min(MAX_LEVEL, levelFromTotalXp(newTotal));

    const monthlyDelta = amount > 0 ? amount : 0;
    const newMonthly = BigInt(row.monthlyXp) + BigInt(monthlyDelta);

    row.totalXp = newTotal.toString();
    row.monthlyXp = (newMonthly < 0n ? 0n : newMonthly).toString();
    row.level = newLevel;
    if (opts.updateMessageCounter) {
      row.messagesCount = (BigInt(row.messagesCount) + 1n).toString();
      row.lastMessageAt = new Date();
    }
    if (opts.updateVoiceMinutes && opts.updateVoiceMinutes > 0) {
      row.voiceMinutes = (BigInt(row.voiceMinutes) + BigInt(opts.updateVoiceMinutes)).toString();
    }
    row.lastActiveAt = new Date();

    const tiers = await this.getTiers(serverId);
    const oldTier = this.resolveTier(tiers, oldLevel);
    const newTier = this.resolveTier(tiers, newLevel);
    row.currentTierId = newTier?.id ?? null;

    await this.xpRepo.save(row);

    await this.logRepo.insert({
      serverId,
      discordId,
      eventType,
      xpAmount: amount,
      newTotal: newTotal.toString(),
      newLevel,
    });

    // Card preview reflects level + stats, so any XP change invalidates it.
    // For voice ticks this fires every minute per active user — cheap (Map delete).
    this.rankCardCache.invalidateUser(serverId, discordId);

    return {
      awarded: amount,
      newTotal,
      oldLevel,
      newLevel,
      oldTier,
      newTier,
      leveledUp: newLevel > oldLevel,
      tierChanged: (newTier?.id ?? null) !== (oldTier?.id ?? null),
    };
  }

  // ── Notifications + role rewards (called after a level-up) ──

  /**
   * After a successful award that triggered level-up, post the notification
   * and update role rewards. Picks tier-milestone text if applicable.
   * Safe to call even when leveledUp === false — it will return early.
   */
  async handleLevelUp(
    guild: Guild,
    member: GuildMember,
    result: AwardXpResult,
  ): Promise<void> {
    if (!result.leveledUp) return;

    const settings = await this.getSettings(guild.id);

    // 1) Role rewards
    try {
      await this.applyRoleRewards(member, settings.roleRewardsMode);
    } catch (e) {
      this.logger.warn(
        `Role rewards apply failed for ${member.user.tag} in ${guild.name}: ${(e as Error).message}`,
      );
    }

    // 2) Notification
    if (settings.notifyOnlyNewTier && !result.tierChanged) return;
    if (!settings.levelupChannelId) return; // disabled

    const tierMessage =
      result.tierChanged && result.newTier?.levelupMessage?.trim()
        ? result.newTier.levelupMessage
        : null;
    const template = tierMessage ?? settings.levelupMessageTemplate;
    const content = renderLevelupMessage(template, {
      user: member.user,
      guild,
      oldLevel: result.oldLevel,
      newLevel: result.newLevel,
      oldTier: result.oldTier,
      newTier: result.newTier,
    });
    if (!content.trim()) return;

    if (settings.levelupChannelId === 'dm') {
      try {
        await member.send({ content });
      } catch {
        // user has DMs disabled — silent fail
      }
      return;
    }
    const channel = guild.channels.cache.get(settings.levelupChannelId);
    if (channel?.isTextBased()) {
      // Personalized identity on premium (TZ §8.2), plain bot send otherwise.
      await this.personalization
        .sendBotMessage(guild, channel as never, { content })
        .catch((e) => this.logger.warn(`Level-up message failed: ${(e as Error).message}`));
    }
  }

  /**
   * Apply role rewards according to the configured mode.
   *   stack   → add every reward role for level <= current; never remove.
   *   replace → ensure ONLY the single highest qualifying reward role is held.
   */
  async applyRoleRewards(member: GuildMember, mode: 'stack' | 'replace'): Promise<void> {
    const serverId = member.guild.id;
    // Premium gate (TZ v2.1 §6): rules stay stored on expiry but silently stop
    // firing; they resume the moment premium is back. Never delete the data.
    if (!(await this.premium.isPremium(serverId))) return;
    const rewards = await this.rewardRepo.find({ where: { serverId } });
    if (!rewards.length) return;

    const xp = await this.xpRepo.findOne({ where: { serverId, discordId: member.user.id } });
    const level = xp?.level ?? 0;

    const qualifying = rewards.filter((r) => r.level <= level).sort((a, b) => b.level - a.level);
    const highest = qualifying[0];
    const allRewardRoleIds = new Set(rewards.map((r) => r.roleId));

    // Make sure roles still exist on the guild before touching them.
    const liveRoleIds = new Set(member.guild.roles.cache.keys());
    const me = member.guild.members.me;
    const botTop = me?.roles.highest?.position ?? 0;

    const toAdd: string[] = [];
    const toRemove: string[] = [];

    if (mode === 'stack') {
      for (const r of qualifying) {
        if (!liveRoleIds.has(r.roleId)) continue;
        if (member.roles.cache.has(r.roleId)) continue;
        const targetRole = member.guild.roles.cache.get(r.roleId);
        if (targetRole && targetRole.position >= botTop) continue;
        toAdd.push(r.roleId);
      }
    } else {
      // replace
      if (highest && liveRoleIds.has(highest.roleId)) {
        const targetRole = member.guild.roles.cache.get(highest.roleId);
        if (targetRole && targetRole.position < botTop) {
          if (!member.roles.cache.has(highest.roleId)) toAdd.push(highest.roleId);
        }
      }
      for (const rid of allRewardRoleIds) {
        if (rid === highest?.roleId) continue;
        if (member.roles.cache.has(rid)) {
          const targetRole = member.guild.roles.cache.get(rid);
          if (targetRole && targetRole.position < botTop) toRemove.push(rid);
        }
      }
    }

    if (toAdd.length) await member.roles.add(toAdd).catch(() => null);
    if (toRemove.length) await member.roles.remove(toRemove).catch(() => null);
  }

  /** Strip all reward roles (used on /xp reset). */
  async stripAllRewardRoles(member: GuildMember): Promise<void> {
    const rewards = await this.rewardRepo.find({ where: { serverId: member.guild.id } });
    if (!rewards.length) return;
    const held = rewards.map((r) => r.roleId).filter((id) => member.roles.cache.has(id));
    if (!held.length) return;
    await member.roles.remove(held).catch(() => null);
  }

  // ── Leaderboard ────────────────────────────────────────

  async leaderboard(serverId: string, scope: 'all' | 'monthly', limit = 10, offset = 0) {
    const column = scope === 'monthly' ? 'monthly_xp' : 'total_xp';
    const rows = await this.xpRepo
      .createQueryBuilder('x')
      .where('x.server_id = :serverId', { serverId })
      .orderBy(`x.${column}`, 'DESC')
      .limit(limit)
      .offset(offset)
      .getMany();
    return rows;
  }

  /**
   * Count of users eligible for the leaderboard. For 'monthly' scope we exclude
   * rows with 0 monthly XP so the page count reflects "ranked this month" rather
   * than "ever existed". For 'all' anybody with any XP shows up so we count > 0.
   */
  async leaderboardCount(serverId: string, scope: 'all' | 'monthly'): Promise<number> {
    const column = scope === 'monthly' ? 'monthly_xp' : 'total_xp';
    const { count } = await this.xpRepo
      .createQueryBuilder('x')
      .select('COUNT(*)', 'count')
      .where('x.server_id = :serverId', { serverId })
      .andWhere(`x.${column} > 0`)
      .getRawOne<{ count: string }>() ?? { count: '0' };
    return Number(count) || 0;
  }

  async rankPosition(serverId: string, discordId: string, scope: 'all' | 'monthly'): Promise<number> {
    const column = scope === 'monthly' ? 'monthly_xp' : 'total_xp';
    const row = await this.xpRepo.findOne({ where: { serverId, discordId } });
    if (!row) return 0;
    const value = scope === 'monthly' ? BigInt(row.monthlyXp) : BigInt(row.totalXp);
    const higher = await this.xpRepo
      .createQueryBuilder('x')
      .where('x.server_id = :serverId', { serverId })
      .andWhere(`x.${column} > :value`, { value: value.toString() })
      .getCount();
    return higher + 1;
  }

  // ── Recalc (used by /xp recalc) ────────────────────────

  async recalcServer(serverId: string): Promise<{ updated: number }> {
    const tiers = await this.getTiers(serverId);
    const all = await this.xpRepo.find({ where: { serverId } });
    let updated = 0;
    for (const row of all) {
      const newLevel = Math.min(MAX_LEVEL, levelFromTotalXp(BigInt(row.totalXp)));
      const newTier = this.resolveTier(tiers, newLevel);
      if (row.level !== newLevel || row.currentTierId !== (newTier?.id ?? null)) {
        row.level = newLevel;
        row.currentTierId = newTier?.id ?? null;
        await this.xpRepo.save(row);
        updated += 1;
      }
    }
    return { updated };
  }

  // ── Monthly reset (called by cron) ─────────────────────

  async resetAllMonthly(): Promise<number> {
    const res = await this.xpRepo
      .createQueryBuilder()
      .update()
      .set({ monthlyXp: '0' })
      .execute();
    return res.affected ?? 0;
  }

  // ── Helpers used by various paths ──────────────────────

  async cumulativeXpForLevel(level: number): Promise<number> {
    return xpToReachLevel(level);
  }

  countRoleRewardsLimitFor(serverId: string): number {
    return this.featureFlags.getFeatureLimit(serverId, 'role_rewards_limit', 50);
  }

  /** Touch lastActiveAt for AFK detection. Lightweight, called from voice state updates. */
  async markActive(serverId: string, discordId: string): Promise<void> {
    const row = await this.getOrCreateXp(serverId, discordId);
    row.lastActiveAt = new Date();
    await this.xpRepo.save(row);
  }

  /** Bulk-delete a user's XP row (used by /xp reset). */
  async resetUser(serverId: string, discordId: string): Promise<void> {
    await this.xpRepo.delete({ serverId, discordId });
    await this.logRepo.insert({
      serverId,
      discordId,
      eventType: 'admin_reset',
      xpAmount: 0,
      newTotal: '0',
      newLevel: 0,
    });
  }

  /** Wipe entire server XP (used by dashboard Advanced). */
  async resetServer(serverId: string): Promise<number> {
    const res = await this.xpRepo.delete({ serverId });
    return res.affected ?? 0;
  }

  // ── Filtering helpers used by chat-XP path ─────────────

  /** True if the message body is non-trivial (≥ min length AND not just emoji/mention/link). */
  static isMessageSubstantive(text: string, minLength: number): boolean {
    if (!text) return false;
    if (text.length < minLength) return false;
    // Strip mentions, custom emojis, URLs, then plain whitespace.
    const stripped = text
      .replace(/<a?:\w+:\d+>/g, '') // custom emoji
      .replace(/<#\d+>/g, '') // channel mention
      .replace(/<@!?\d+>/g, '') // user mention
      .replace(/<@&\d+>/g, '') // role mention
      .replace(/https?:\/\/\S+/gi, '') // urls
      .replace(/\p{Extended_Pictographic}/gu, '') // unicode emoji
      .trim();
    return stripped.length >= Math.max(1, Math.floor(minLength / 2));
  }

  /** Find all UserXp rows for a server matched by a list of discord ids. */
  async findManyXp(serverId: string, ids: string[]): Promise<UserXp[]> {
    if (!ids.length) return [];
    return this.xpRepo.find({ where: { serverId, discordId: In(ids) } });
  }
}
