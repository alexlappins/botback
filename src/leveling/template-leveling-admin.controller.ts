import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { AdminGuard } from '../auth/admin.guard';
import { SessionGuard } from '../auth/session.guard';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { NoCacheInterceptor } from '../server-templates/no-cache.interceptor';

import { TemplateLevelingSettings } from './entities/template-leveling-settings.entity';
import { TemplateNoXpChannel } from './entities/template-no-xp-channel.entity';
import { TemplateNoXpRole } from './entities/template-no-xp-role.entity';
import { TemplateRoleReward } from './entities/template-role-reward.entity';
import { TemplateTier } from './entities/template-tier.entity';

const DEFAULT_TIER_TEMPLATE = [
  { name: 'Newbie', emoji: '🌱', startLevel: 1, endLevel: 5, color: '#94a3b8' },
  { name: 'Regular', emoji: '⭐', startLevel: 6, endLevel: 15, color: '#60a5fa' },
  { name: 'Active', emoji: '🔥', startLevel: 16, endLevel: 30, color: '#22d3ee' },
  { name: 'Veteran', emoji: '⚔️', startLevel: 31, endLevel: 50, color: '#a78bfa' },
  { name: 'Elite', emoji: '💎', startLevel: 51, endLevel: 75, color: '#f472b6' },
  { name: 'Legend', emoji: '🏆', startLevel: 76, endLevel: 100, color: '#facc15' },
  { name: 'Mythic', emoji: '🌌', startLevel: 101, endLevel: 9999, color: '#f97316' },
];

/**
 * Owner-admin REST for editing a server template's leveling block.
 *
 * Mirrors {@link LevelingController}, but operates on `template_id` and uses
 * names instead of Discord IDs for roles/channels. AdminGuard means only the
 * Level Up Bot owner-admin sees these endpoints — clients see the regular
 * per-guild ones via the dashboard.
 */
@Controller('api/server-templates/:templateId/leveling')
@UseGuards(SessionGuard, AdminGuard)
@UseInterceptors(NoCacheInterceptor)
export class TemplateLevelingAdminController {
  constructor(
    @InjectRepository(ServerTemplate)
    private readonly templateRepo: Repository<ServerTemplate>,
    @InjectRepository(TemplateLevelingSettings)
    private readonly settingsRepo: Repository<TemplateLevelingSettings>,
    @InjectRepository(TemplateTier)
    private readonly tierRepo: Repository<TemplateTier>,
    @InjectRepository(TemplateRoleReward)
    private readonly rewardRepo: Repository<TemplateRoleReward>,
    @InjectRepository(TemplateNoXpRole)
    private readonly noXpRoleRepo: Repository<TemplateNoXpRole>,
    @InjectRepository(TemplateNoXpChannel)
    private readonly noXpChannelRepo: Repository<TemplateNoXpChannel>,
  ) {}

  // ── Helpers ──────────────────────────────────────────

  private async ensureTemplate(templateId: string): Promise<ServerTemplate> {
    const t = await this.templateRepo.findOne({ where: { id: templateId } });
    if (!t) throw new NotFoundException('Template not found');
    return t;
  }

  /**
   * Idempotently get-or-create the settings row. Owner-admin can open the
   * leveling editor before flipping `leveling_enabled` on, so we don't gate
   * write access on the flag — only on template existence.
   */
  private async getOrCreateSettings(templateId: string): Promise<TemplateLevelingSettings> {
    await this.ensureTemplate(templateId);
    let s = await this.settingsRepo.findOne({ where: { templateId } });
    if (!s) {
      s = this.settingsRepo.create({ templateId });
      s = await this.settingsRepo.save(s);
      // Seed the default tier ladder so the editor isn't empty on first open.
      const existing = await this.tierRepo.count({ where: { templateId } });
      if (existing === 0) {
        await this.tierRepo.save(
          DEFAULT_TIER_TEMPLATE.map((t, i) =>
            this.tierRepo.create({
              templateId,
              name: t.name,
              emoji: t.emoji,
              startLevel: t.startLevel,
              endLevel: t.endLevel,
              color: t.color,
              sortOrder: i,
            }),
          ),
        );
      }
    }
    return s;
  }

  // ── Full state ───────────────────────────────────────

  @Get()
  async getAll(@Param('templateId') templateId: string) {
    const template = await this.ensureTemplate(templateId);
    const settings = await this.getOrCreateSettings(templateId);
    const [tiers, rewards, noRoles, noChannels] = await Promise.all([
      this.tierRepo.find({ where: { templateId }, order: { startLevel: 'ASC' } }),
      this.rewardRepo.find({ where: { templateId }, order: { level: 'ASC' } }),
      this.noXpRoleRepo.find({ where: { templateId } }),
      this.noXpChannelRepo.find({ where: { templateId } }),
    ]);
    return {
      enabled: template.levelingEnabled,
      settings,
      tiers,
      rewards,
      noXpRoles: noRoles,
      noXpChannels: noChannels,
    };
  }

  // ── Toggle leveling on/off for this template ─────────

  @Patch('enabled')
  async toggleEnabled(
    @Param('templateId') templateId: string,
    @Body() body: { enabled: boolean },
  ) {
    await this.ensureTemplate(templateId);
    await this.templateRepo.update(templateId, { levelingEnabled: !!body.enabled });
    return { enabled: !!body.enabled };
  }

  // ── Settings ─────────────────────────────────────────

  @Put('settings')
  async updateSettings(
    @Param('templateId') templateId: string,
    @Body() body: Partial<TemplateLevelingSettings>,
  ) {
    const current = await this.getOrCreateSettings(templateId);
    const allowedKeys = [
      'enabled',
      'levelupChannelName',
      'levelupChannelMode',
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
    // Sanity-clamp
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
    if (
      current.levelupChannelMode !== 'channel' &&
      current.levelupChannelMode !== 'dm' &&
      current.levelupChannelMode !== 'disabled'
    ) {
      current.levelupChannelMode = 'channel';
    }
    await this.settingsRepo.save(current);
    return current;
  }

  // ── Tiers ────────────────────────────────────────────

  @Put('tiers')
  async replaceTiers(
    @Param('templateId') templateId: string,
    @Body() body: { tiers: Partial<TemplateTier>[] },
  ) {
    await this.ensureTemplate(templateId);
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

    const existing = await this.tierRepo.find({ where: { templateId } });
    const keepIds = new Set(cleaned.filter((t) => t.id).map((t) => t.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) await this.tierRepo.delete({ id: In(toDelete) });

    for (const t of cleaned) {
      if (t.id) {
        await this.tierRepo.update({ id: t.id, templateId }, { ...t, templateId });
      } else {
        await this.tierRepo.save(this.tierRepo.create({ ...t, templateId }));
      }
    }
    return this.tierRepo.find({ where: { templateId }, order: { startLevel: 'ASC' } });
  }

  @Put('tiers/reset')
  async resetTiers(@Param('templateId') templateId: string) {
    await this.ensureTemplate(templateId);
    await this.tierRepo.delete({ templateId });
    const rows = DEFAULT_TIER_TEMPLATE.map((t, i) =>
      this.tierRepo.create({
        templateId,
        name: t.name,
        emoji: t.emoji,
        startLevel: t.startLevel,
        endLevel: t.endLevel,
        color: t.color,
        sortOrder: i,
      }),
    );
    await this.tierRepo.save(rows);
    return this.tierRepo.find({ where: { templateId }, order: { startLevel: 'ASC' } });
  }

  // ── Role rewards ─────────────────────────────────────

  @Put('role-rewards')
  async replaceRoleRewards(
    @Param('templateId') templateId: string,
    @Body() body: { rewards: { id?: string; level: number; roleName: string }[] },
  ) {
    await this.ensureTemplate(templateId);
    const incoming = Array.isArray(body?.rewards) ? body.rewards : [];
    // De-dupe by level (each level can have only one reward)
    const byLevel = new Map<number, { id?: string; level: number; roleName: string }>();
    for (const r of incoming) {
      const lvl = clamp(Math.floor(r.level), 1, 1000);
      const roleName = r.roleName?.toString().trim();
      if (!roleName) continue;
      byLevel.set(lvl, { id: r.id, level: lvl, roleName });
    }
    const cleaned = [...byLevel.values()];

    const existing = await this.rewardRepo.find({ where: { templateId } });
    const keepIds = new Set(cleaned.filter((r) => r.id).map((r) => r.id as string));
    const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id);
    if (toDelete.length) await this.rewardRepo.delete({ id: In(toDelete) });

    for (const r of cleaned) {
      if (r.id) {
        await this.rewardRepo.update(
          { id: r.id, templateId },
          { level: r.level, roleName: r.roleName },
        );
      } else {
        await this.rewardRepo.save(
          this.rewardRepo.create({ templateId, level: r.level, roleName: r.roleName }),
        );
      }
    }
    return this.rewardRepo.find({ where: { templateId }, order: { level: 'ASC' } });
  }

  // ── No-XP roles ──────────────────────────────────────

  @Put('no-xp-roles')
  async replaceNoXpRoles(
    @Param('templateId') templateId: string,
    @Body() body: { roleNames: string[] },
  ) {
    await this.ensureTemplate(templateId);
    const wanted = new Set((body?.roleNames ?? []).map((s) => s.trim()).filter(Boolean));
    await this.noXpRoleRepo.delete({ templateId });
    if (wanted.size) {
      await this.noXpRoleRepo.save(
        [...wanted].map((roleName) =>
          this.noXpRoleRepo.create({ templateId, roleName }),
        ),
      );
    }
    return this.noXpRoleRepo.find({ where: { templateId } });
  }

  // ── No-XP channels ───────────────────────────────────

  @Put('no-xp-channels')
  async replaceNoXpChannels(
    @Param('templateId') templateId: string,
    @Body() body: { text?: string[]; voice?: string[] },
  ) {
    await this.ensureTemplate(templateId);
    const text = uniqueClean(body?.text);
    const voice = uniqueClean(body?.voice);
    await this.noXpChannelRepo.delete({ templateId });
    const rows = [
      ...text.map((name) =>
        this.noXpChannelRepo.create({
          templateId,
          channelName: name,
          channelType: 'text' as const,
        }),
      ),
      ...voice.map((name) =>
        this.noXpChannelRepo.create({
          templateId,
          channelName: name,
          channelType: 'voice' as const,
        }),
      ),
    ];
    if (rows.length) await this.noXpChannelRepo.save(rows);
    return this.noXpChannelRepo.find({ where: { templateId } });
  }

  // ── Wipe everything (used by owner-admin "Reset" button) ─────

  @Delete()
  async wipe(@Param('templateId') templateId: string) {
    await this.ensureTemplate(templateId);
    await this.rewardRepo.delete({ templateId });
    await this.noXpRoleRepo.delete({ templateId });
    await this.noXpChannelRepo.delete({ templateId });
    await this.tierRepo.delete({ templateId });
    await this.settingsRepo.delete({ templateId });
    await this.templateRepo.update(templateId, { levelingEnabled: false });
    return { ok: true };
  }
}

function clamp(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function uniqueClean(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const set = new Set<string>();
  for (const v of arr) {
    if (typeof v === 'string' && v.trim()) set.add(v.trim());
  }
  return [...set];
}

