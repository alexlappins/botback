import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Client } from 'discord.js';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { FeatureFlagsService } from '../common/feature-flags/feature-flags.service';

import { IgnoredUser } from './entities/ignored-user.entity';
import { NoXpChannel } from './entities/no-xp-channel.entity';
import { NoXpRole } from './entities/no-xp-role.entity';
import { RoleReward } from './entities/role-reward.entity';
import { ServerLevelingSettings } from './entities/server-leveling-settings.entity';
import { ServerTier } from './entities/server-tier.entity';
import { UserXp } from './entities/user-xp.entity';
import { XpEventLog } from './entities/xp-event-log.entity';
import { LevelingService } from './leveling.service';
import { RankCardCacheService } from './rank-card-cache.service';
import {
  RankCardRendererService,
  buildRankCardData,
  type RankCardStyle,
} from './rank-card-renderer.service';

const DEFAULT_TIER_TEMPLATE = [
  { name: 'Newbie', emoji: '🌱', startLevel: 1, endLevel: 5, color: '#94a3b8' },
  { name: 'Regular', emoji: '⭐', startLevel: 6, endLevel: 15, color: '#60a5fa' },
  { name: 'Active', emoji: '🔥', startLevel: 16, endLevel: 30, color: '#22d3ee' },
  { name: 'Veteran', emoji: '⚔️', startLevel: 31, endLevel: 50, color: '#a78bfa' },
  { name: 'Elite', emoji: '💎', startLevel: 51, endLevel: 75, color: '#f472b6' },
  { name: 'Legend', emoji: '🏆', startLevel: 76, endLevel: 100, color: '#facc15' },
  { name: 'Mythic', emoji: '🌌', startLevel: 101, endLevel: 9999, color: '#f97316' },
];

@Controller('api/guilds/:guildId/leveling')
@UseGuards(SessionGuard, CustomerGuard)
export class LevelingController {
  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly leveling: LevelingService,
    private readonly guilds: GuildsService,
    private readonly featureFlags: FeatureFlagsService,
    @InjectRepository(ServerLevelingSettings)
    private readonly settingsRepo: Repository<ServerLevelingSettings>,
    @InjectRepository(ServerTier)
    private readonly tierRepo: Repository<ServerTier>,
    @InjectRepository(RoleReward)
    private readonly rewardRepo: Repository<RoleReward>,
    @InjectRepository(NoXpRole)
    private readonly noXpRoleRepo: Repository<NoXpRole>,
    @InjectRepository(NoXpChannel)
    private readonly noXpChannelRepo: Repository<NoXpChannel>,
    @InjectRepository(IgnoredUser)
    private readonly ignoredRepo: Repository<IgnoredUser>,
    @InjectRepository(UserXp)
    private readonly xpRepo: Repository<UserXp>,
    @InjectRepository(XpEventLog)
    private readonly eventLogRepo: Repository<XpEventLog>,
    private readonly rankCardRenderer: RankCardRendererService,
    private readonly rankCardCache: RankCardCacheService,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this guild');
    }
  }

  // ── Full state for the dashboard page ──────────────────

  @Get()
  async getAll(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const [settings, tiers, rewards, noRoles, noChannels, ignored] = await Promise.all([
      this.leveling.getSettings(guildId),
      this.leveling.getTiers(guildId),
      this.rewardRepo.find({ where: { serverId: guildId }, order: { level: 'ASC' } }),
      this.noXpRoleRepo.find({ where: { serverId: guildId } }),
      this.noXpChannelRepo.find({ where: { serverId: guildId } }),
      this.ignoredRepo.find({ where: { serverId: guildId } }),
    ]);

    const roleHierarchyWarnings = await this.collectRoleHierarchyWarnings(guildId, rewards);

    return {
      settings,
      tiers,
      rewards,
      noXpRoles: noRoles,
      noXpChannels: noChannels,
      ignoredUsers: ignored,
      limits: {
        roleRewards: this.featureFlags.getFeatureLimit(guildId, 'role_rewards_limit', 50),
      },
      warnings: { roleHierarchy: roleHierarchyWarnings },
    };
  }

  // ── Settings ──────────────────────────────────────────

  @Put('settings')
  async updateSettings(
    @Param('guildId') guildId: string,
    @Body() body: Partial<ServerLevelingSettings>,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const current = await this.leveling.getSettings(guildId);
    const allowedKeys = [
      'enabled',
      'levelupChannelId',
      'levelupMessageTemplate',
      'notifyOnlyNewTier',
      'chatXpEnabled',
      'chatXpMin',
      'chatXpMax',
      'chatXpCooldown',
      'chatXpMinLength',
      'voiceXpEnabled',
      'voiceXpPerMinute',
      'voiceXpMinUsers',
      'voiceXpAfkMinutes',
      'roleRewardsMode',
      'rankBgImageUrl',
      'rankBgColor',
      'rankOverlayOpacity',
      'rankPrimaryTextColor',
      'rankSecondaryTextColor',
      'rankAccentColor',
      'rankProgressColor',
      'rankProgressBgColor',
    ] as const;
    for (const k of allowedKeys) {
      if (body[k] !== undefined) {
        (current as unknown as Record<string, unknown>)[k] = body[k] as unknown;
      }
    }
    // Sanity-clamp numeric ranges
    current.chatXpMin = clamp(current.chatXpMin, 0, 1000);
    current.chatXpMax = clamp(current.chatXpMax, current.chatXpMin, 1000);
    current.chatXpCooldown = clamp(current.chatXpCooldown, 0, 86400);
    current.chatXpMinLength = clamp(current.chatXpMinLength, 0, 2000);
    current.voiceXpPerMinute = clamp(current.voiceXpPerMinute, 0, 1000);
    current.voiceXpMinUsers = clamp(current.voiceXpMinUsers, 1, 99);
    current.voiceXpAfkMinutes = clamp(current.voiceXpAfkMinutes, 1, 1440);
    current.rankOverlayOpacity = clamp(current.rankOverlayOpacity, 0, 100);
    if (current.roleRewardsMode !== 'stack' && current.roleRewardsMode !== 'replace') {
      current.roleRewardsMode = 'stack';
    }
    await this.settingsRepo.save(current);
    this.rankCardCache.invalidateServer(guildId);
    return current;
  }

  // ── Tiers ─────────────────────────────────────────────

  @Put('tiers')
  async replaceTiers(
    @Param('guildId') guildId: string,
    @Body() body: { tiers: Partial<ServerTier>[] },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const incoming = Array.isArray(body?.tiers) ? body.tiers : [];
    const cleaned = incoming
      .filter((t) => t && typeof t.name === 'string' && t.name.trim())
      .map((t, i) => ({
        id: t.id,
        name: t.name!.trim().slice(0, 64),
        emoji: t.emoji?.toString().slice(0, 64) ?? null,
        iconUrl: t.iconUrl ?? null,
        startLevel: clamp(t.startLevel ?? 1, 1, 9999),
        endLevel: clamp(t.endLevel ?? 9999, 1, 9999),
        color: typeof t.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(t.color) ? t.color : '#8b5cf6',
        levelupMessage: t.levelupMessage?.toString() ?? null,
        sortOrder: i,
      }))
      .sort((a, b) => a.startLevel - b.startLevel)
      .map((t, i) => ({ ...t, sortOrder: i }));

    const existing = await this.tierRepo.find({ where: { serverId: guildId } });
    const keepIds = new Set(cleaned.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) await this.tierRepo.delete({ id: In(toDelete) });

    for (const t of cleaned) {
      if (t.id) {
        await this.tierRepo.update({ id: t.id, serverId: guildId }, { ...t, serverId: guildId });
      } else {
        await this.tierRepo.save(this.tierRepo.create({ ...t, serverId: guildId }));
      }
    }
    this.rankCardCache.invalidateServer(guildId);
    return this.leveling.getTiers(guildId);
  }

  @Put('tiers/reset')
  async resetTiers(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    await this.tierRepo.delete({ serverId: guildId });
    const rows = DEFAULT_TIER_TEMPLATE.map((t, i) =>
      this.tierRepo.create({
        serverId: guildId,
        name: t.name,
        emoji: t.emoji,
        startLevel: t.startLevel,
        endLevel: t.endLevel,
        color: t.color,
        sortOrder: i,
      }),
    );
    await this.tierRepo.save(rows);
    this.rankCardCache.invalidateServer(guildId);
    return this.leveling.getTiers(guildId);
  }

  // ── Role rewards ──────────────────────────────────────

  @Put('role-rewards')
  async replaceRoleRewards(
    @Param('guildId') guildId: string,
    @Body() body: { rewards: { id?: string; level: number; roleId: string }[] },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const limit = this.featureFlags.getFeatureLimit(guildId, 'role_rewards_limit', 50);
    const incoming = Array.isArray(body?.rewards) ? body.rewards : [];
    if (incoming.length > limit) {
      throw new BadRequestException(`Too many role rewards (limit: ${limit})`);
    }
    // De-dupe by level (each level can have only one reward)
    const byLevel = new Map<number, { id?: string; level: number; roleId: string }>();
    for (const r of incoming) {
      const lvl = clamp(Math.floor(r.level), 1, 1000);
      const rid = r.roleId?.toString().trim();
      if (!rid) continue;
      byLevel.set(lvl, { id: r.id, level: lvl, roleId: rid });
    }
    const cleaned = [...byLevel.values()];

    const existing = await this.rewardRepo.find({ where: { serverId: guildId } });
    const keepIds = new Set(cleaned.filter((r) => r.id).map((r) => r.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) await this.rewardRepo.delete({ id: In(toDelete) });

    for (const r of cleaned) {
      if (r.id) {
        await this.rewardRepo.update(
          { id: r.id, serverId: guildId },
          { level: r.level, roleId: r.roleId },
        );
      } else {
        await this.rewardRepo.save(
          this.rewardRepo.create({ serverId: guildId, level: r.level, roleId: r.roleId }),
        );
      }
    }
    return this.rewardRepo.find({ where: { serverId: guildId }, order: { level: 'ASC' } });
  }

  // ── No-XP roles / channels ────────────────────────────

  @Put('no-xp-roles')
  async replaceNoXpRoles(
    @Param('guildId') guildId: string,
    @Body() body: { roleIds: string[] },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const wanted = new Set((body?.roleIds ?? []).map((s) => s.trim()).filter(Boolean));
    await this.noXpRoleRepo.delete({ serverId: guildId });
    if (wanted.size) {
      await this.noXpRoleRepo.save(
        [...wanted].map((roleId) =>
          this.noXpRoleRepo.create({ serverId: guildId, roleId }),
        ),
      );
    }
    return this.noXpRoleRepo.find({ where: { serverId: guildId } });
  }

  @Put('no-xp-channels')
  async replaceNoXpChannels(
    @Param('guildId') guildId: string,
    @Body() body: { text?: string[]; voice?: string[] },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const text = uniqueClean(body?.text);
    const voice = uniqueClean(body?.voice);
    await this.noXpChannelRepo.delete({ serverId: guildId });
    const rows = [
      ...text.map((id) =>
        this.noXpChannelRepo.create({ serverId: guildId, channelId: id, channelType: 'text' as const }),
      ),
      ...voice.map((id) =>
        this.noXpChannelRepo.create({ serverId: guildId, channelId: id, channelType: 'voice' as const }),
      ),
    ];
    if (rows.length) await this.noXpChannelRepo.save(rows);
    return this.noXpChannelRepo.find({ where: { serverId: guildId } });
  }

  // ── Ignored users (read + remove from dashboard) ──────

  @Delete('ignored-users/:userId')
  async removeIgnored(
    @Param('guildId') guildId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const r = await this.ignoredRepo.delete({ serverId: guildId, discordId: userId });
    if (r.affected === 0) throw new NotFoundException('User not in ignore list');
    return { ok: true };
  }

  // ── Advanced ──────────────────────────────────────────

  @Put('recalc')
  async recalc(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.leveling.recalcServer(guildId);
  }

  @Delete('xp-all')
  async wipe(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const affected = await this.leveling.resetServer(guildId);
    return { ok: true, affected };
  }

  /**
   * CSV export of the guild's XP table. Streams in one shot — for very large
   * guilds (>100k members) this would need pagination, but at MVP scale a
   * single `find()` is fine and matches what the spec asks for ("Экспорт XP
   * списка в CSV — кнопка").
   *
   * Gated by `xp_export` feature flag (default true on free plan).
   */
  @Get('xp-export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Param('guildId') guildId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.ensureAccess(guildId, req);
    if (!this.featureFlags.hasFeature(guildId, 'xp_export')) {
      throw new BadRequestException('CSV export disabled on the current plan');
    }
    const rows = await this.xpRepo.find({
      where: { serverId: guildId },
      order: { totalXp: 'DESC' },
    });
    const header = 'discord_id,level,total_xp,monthly_xp,messages_count,voice_minutes,last_active_at\n';
    const body = rows
      .map((r) =>
        [
          r.discordId,
          r.level,
          r.totalXp,
          r.monthlyXp,
          r.messagesCount,
          r.voiceMinutes,
          r.lastActiveAt ? r.lastActiveAt.toISOString() : '',
        ].join(','),
      )
      .join('\n');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="xp-${guildId}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(header + body);
  }

  // ── Audit log (xp_events_log) ─────────────────────────

  /**
   * Paginated XP event feed. Newest first. Optional filters:
   *   - `userId`: only events for one Discord user
   *   - `type`: comma-separated event types (chat, voice, admin_give, admin_remove, admin_set, admin_reset)
   *   - `limit`: 1..200 (default 50), `offset`: >=0 (default 0)
   *
   * Returned shape includes `total` so the dashboard can render proper pagination.
   */
  @Get('events')
  async listEvents(
    @Param('guildId') guildId: string,
    @Query('userId') userId: string | undefined,
    @Query('type') type: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('offset') offsetRaw: string | undefined,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    const limit = clampInt(limitRaw, 1, 200, 50);
    const offset = Math.max(0, Number(offsetRaw) || 0);
    const types = (type ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean) as XpEventLog['eventType'][];

    const qb = this.eventLogRepo
      .createQueryBuilder('e')
      .where('e.server_id = :guildId', { guildId });
    if (userId) qb.andWhere('e.discord_id = :userId', { userId });
    if (types.length) qb.andWhere('e.event_type IN (:...types)', { types });

    const [rows, total] = await Promise.all([
      qb
        .clone()
        .orderBy('e.created_at', 'DESC')
        .limit(limit)
        .offset(offset)
        .getMany(),
      qb.getCount(),
    ]);
    return {
      total,
      limit,
      offset,
      events: rows.map((r) => ({
        id: r.id,
        discordId: r.discordId,
        eventType: r.eventType,
        xpAmount: r.xpAmount,
        newTotal: r.newTotal,
        newLevel: r.newLevel,
        createdAt: r.createdAt,
      })),
    };
  }

  // ── Rank card preview (dashboard live preview) ────────

  /**
   * Render a sample rank card with the supplied style overrides. Used by the
   * dashboard "Rank Card" block for the live preview. We accept the style in
   * the body so the admin sees the result of unsaved edits without persisting.
   * Sample user data is hard-coded — the admin is tuning visuals, not data.
   */
  @Put('preview-image')
  async previewImage(
    @Param('guildId') guildId: string,
    @Body() body: Partial<RankCardStyle>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.ensureAccess(guildId, req);
    const settings = await this.leveling.getSettings(guildId);
    const style: RankCardStyle = {
      rankBgImageUrl: body.rankBgImageUrl ?? settings.rankBgImageUrl,
      rankBgColor: body.rankBgColor ?? settings.rankBgColor,
      rankOverlayOpacity: body.rankOverlayOpacity ?? settings.rankOverlayOpacity,
      rankPrimaryTextColor: body.rankPrimaryTextColor ?? settings.rankPrimaryTextColor,
      rankSecondaryTextColor: body.rankSecondaryTextColor ?? settings.rankSecondaryTextColor,
      rankAccentColor: body.rankAccentColor ?? settings.rankAccentColor,
      rankProgressColor: body.rankProgressColor ?? settings.rankProgressColor,
      rankProgressBgColor: body.rankProgressBgColor ?? settings.rankProgressBgColor,
    };
    // Default avatar #2 from Discord CDN — neutral placeholder.
    const sampleAvatar = 'https://cdn.discordapp.com/embed/avatars/2.png';
    const png = await this.rankCardRenderer.render(
      buildRankCardData({
        username: 'TestUser',
        avatarUrl: sampleAvatar,
        level: 25,
        totalXp: 12450n,
        rank: 5,
        totalMembers: 234,
        messagesCount: 1234,
        voiceMinutes: 320,
        tier: { name: 'Veteran', emoji: '⚔️', color: style.rankAccentColor } as never,
      }),
      style,
    );
    if (!png) throw new BadRequestException('Failed to render preview');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  }

  /**
   * Render the requesting admin's real rank card and post it into the chosen
   * channel — mirrors "Send test welcome image". Doesn't bypass the rendered-
   * card cache (admin sees the same thing users would see, including stale-by-
   * design behaviour up to TTL).
   */
  @Put('test-card')
  async sendTestCard(
    @Param('guildId') guildId: string,
    @Body() body: { channelId: string },
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    if (!body?.channelId) throw new BadRequestException('channelId required');

    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new NotFoundException('Guild not available to the bot');

    const channel = guild.channels.cache.get(body.channelId);
    if (!channel?.isTextBased()) throw new BadRequestException('Channel is not a text channel');

    const user = (req as Request & { user: SessionUser }).user;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new BadRequestException('You are not a member of this guild');

    const png = await this.leveling.renderRankCard({
      serverId: guildId,
      memberId: member.id,
      username: member.user.username,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
    });
    if (!png) throw new BadRequestException('Failed to render rank card');

    await channel.send({
      content: `Тестовая карта ранга для <@${member.id}>`,
      files: [{ attachment: png, name: `rank-${member.id}.png` }],
    });
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────

  private async collectRoleHierarchyWarnings(
    guildId: string,
    rewards: RoleReward[],
  ): Promise<string[]> {
    if (!rewards.length) return [];
    const guild =
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) return [];
    const me = guild.members.me;
    const botTop = me?.roles.highest?.position ?? 0;
    const warnings: string[] = [];
    for (const r of rewards) {
      const role = guild.roles.cache.get(r.roleId);
      if (!role) {
        warnings.push(`Role ${r.roleId} (level ${r.level}) no longer exists`);
        continue;
      }
      if (role.position >= botTop) {
        warnings.push(
          `Bot is below role "${role.name}" (level ${r.level}) — Discord won’t let it assign`,
        );
      }
    }
    return warnings;
  }
}

function clamp(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** Same as clamp() but takes a string query param and a fallback for empty/NaN. */
function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniqueClean(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const set = new Set<string>();
  for (const v of arr) {
    if (typeof v === 'string' && v.trim()) set.add(v.trim());
  }
  return [...set];
}
