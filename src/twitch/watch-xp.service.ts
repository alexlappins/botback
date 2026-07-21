import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client } from 'discord.js';

import { LevelingService } from '../leveling/leveling.service';
import { UserXp } from '../leveling/entities/user-xp.entity';
import { PremiumService } from '../premium/premium.service';
import { TwitchConnection } from './entities/twitch-features.entities';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchOAuthService } from './twitch-oauth.service';

const TICK_MINUTES = 5;
const MIN_LIVE_MINUTES = 10; // §2.3 anti-abuse: stream must be live >10 min
/** Twitch global budget: 800 req/min — stay far below (§2.7). */
const MAX_CHATTER_CALLS_PER_TICK = 300;

/**
 * Watch Time XP (TZ-B §2, Premium): every 5 minutes, for each live connected
 * channel, fetch chatters and award XP to linked viewers STRICTLY through the
 * existing leveling service (multipliers, no-XP rules, level-up messages and
 * Role Rewards all apply). Batched, capped daily, abuse-guarded.
 */
@Injectable()
export class WatchXpService {
  private readonly logger = new Logger(WatchXpService.name);
  private callsThisTick = 0;

  constructor(
    @InjectRepository(TwitchConnection)
    private readonly connRepo: Repository<TwitchConnection>,
    @InjectRepository(UserXp)
    private readonly xpRepo: Repository<UserXp>,
    private readonly oauth: TwitchOAuthService,
    private readonly helix: TwitchHelixService,
    private readonly leveling: LevelingService,
    private readonly premium: PremiumService,
    @Inject(Client) private readonly discord: Client,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'twitch.watch_xp' })
  async tick(): Promise<void> {
    this.callsThisTick = 0;
    const connections = await this.connRepo.find({ where: { status: 'active' } });
    if (!connections.length) return;

    // One Get Streams batch to find which connected channels are live.
    const ids = [...new Set(connections.map((c) => c.twitchUserId))];
    const live = new Map<string, { started_at: string }>();
    for (let i = 0; i < ids.length; i += 100) {
      const streams = await this.helix.getStreamsByUserIds(ids.slice(i, i + 100)).catch(() => []);
      for (const s of streams) live.set(s.user_id, s);
    }

    for (const conn of connections) {
      const stream = live.get(conn.twitchUserId);
      if (!stream) continue;
      const liveMinutes = (Date.now() - new Date(stream.started_at).getTime()) / 60_000;
      if (liveMinutes < MIN_LIVE_MINUTES) continue;
      if (this.callsThisTick >= MAX_CHATTER_CALLS_PER_TICK) {
        // §2.7: over budget — stretch the interval instead of failing.
        this.logger.warn('Chatter call budget exhausted this tick — remaining channels postponed');
        break;
      }
      await this.processChannel(conn).catch((e) =>
        this.logger.warn(`watch xp for ${conn.twitchLogin}: ${(e as Error).message}`),
      );
    }
  }

  private async processChannel(conn: TwitchConnection): Promise<void> {
    if (!(await this.premium.isPremium(conn.guildId))) return;
    const settings = await this.leveling.getSettings(conn.guildId);
    if (!settings.enabled || !settings.watchXpEnabled) return;

    const token = await this.oauth.getStreamerToken(conn);
    if (!token) return; // revoked — silently stops (§1.3)

    this.callsThisTick += 1;
    const chatters = await this.helix.getChatters(conn.twitchUserId, token);
    if (!chatters.length) return;

    const links = await this.oauth.viewerLinksByTwitchIds(chatters.map((c) => c.user_id));
    if (!links.length) return;

    const guild = this.discord.guilds.cache.get(conn.guildId);
    const perTick = Math.max(1, settings.watchXpPerTick ?? 10);
    const dailyCap = Math.max(perTick, settings.watchXpDailyCap ?? 600);
    const today = new Date().toISOString().slice(0, 10);

    let awarded = 0;
    for (const link of links) {
      // Must actually be a member of THIS guild.
      const member =
        guild?.members.cache.get(link.discordUserId) ??
        (await guild?.members.fetch(link.discordUserId).catch(() => null));
      if (!member || member.user.bot) continue;
      if (await this.leveling.isIgnored(conn.guildId, link.discordUserId)) continue;
      if (await this.leveling.hasNoXpRole(member)) continue;

      // Daily cap bookkeeping lives on the XP row (§2.3).
      const xpRow = await this.leveling.getOrCreateXp(conn.guildId, link.discordUserId);
      const usedToday = xpRow.watchXpDay === today ? (xpRow.watchXpToday ?? 0) : 0;
      if (usedToday >= dailyCap) continue;
      const amount = Math.min(perTick, dailyCap - usedToday);

      const result = await this.leveling.awardXp(conn.guildId, link.discordUserId, amount, 'watch', {
        updateWatchMinutes: TICK_MINUTES,
      });
      await this.xpRepo.update(
        { serverId: conn.guildId, discordId: link.discordUserId },
        { watchXpToday: usedToday + amount, watchXpDay: today },
      );
      awarded += 1;

      if (result.leveledUp && guild && member) {
        await this.leveling.handleLevelUp(guild, member, result).catch(() => null);
      }
      // §2.5 watch-hours role rewards.
      await this.applyWatchRoleRewards(conn.guildId, member.id).catch(() => null);
    }
    if (awarded) {
      this.logger.debug(`watch xp: ${awarded} viewer(s) awarded in ${conn.guildId} (${conn.twitchLogin})`);
    }
  }

  /** "N hours watched → role X" via the existing Role Rewards mechanism. */
  private async applyWatchRoleRewards(guildId: string, discordId: string): Promise<void> {
    const rewards = await this.leveling.getWatchRoleRewards(guildId);
    if (!rewards.length) return;
    if (!(await this.premium.isPremium(guildId))) return; // role rewards are premium
    const xpRow = await this.leveling.getOrCreateXp(guildId, discordId);
    const hours = Number(BigInt(xpRow.watchMinutes ?? '0')) / 60;
    const guild = this.discord.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(discordId).catch(() => null) : null;
    if (!member) return;
    for (const reward of rewards) {
      if (reward.watchHours != null && hours >= reward.watchHours && !member.roles.cache.has(reward.roleId)) {
        await member.roles.add(reward.roleId, `Watch time reward: ${reward.watchHours}h`).catch(() => null);
      }
    }
  }

  /** "Top Fans" leaderboard (§2.5). */
  async topFans(guildId: string, limit = 10): Promise<{ discordId: string; watchMinutes: number; level: number }[]> {
    const rows = await this.xpRepo
      .createQueryBuilder('x')
      .where('x.server_id = :guildId', { guildId })
      .andWhere('x.watch_minutes > 0')
      .orderBy('x.watch_minutes', 'DESC')
      .take(limit)
      .getMany();
    return rows.map((r) => ({
      discordId: r.discordId,
      watchMinutes: Number(BigInt(r.watchMinutes ?? '0')),
      level: r.level,
    }));
  }
}
