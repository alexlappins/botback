import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ChannelType, type Guild } from 'discord.js';
import { Repository } from 'typeorm';

import { IgnoredUser } from './entities/ignored-user.entity';
import { NoXpChannel } from './entities/no-xp-channel.entity';
import { NoXpRole } from './entities/no-xp-role.entity';
import { RoleReward } from './entities/role-reward.entity';
import { ServerLevelingSettings } from './entities/server-leveling-settings.entity';
import { ServerTier } from './entities/server-tier.entity';
import { TemplateLevelingSettings } from './entities/template-leveling-settings.entity';
import { TemplateNoXpChannel } from './entities/template-no-xp-channel.entity';
import { TemplateNoXpRole } from './entities/template-no-xp-role.entity';
import { TemplateRoleReward } from './entities/template-role-reward.entity';
import { TemplateTier } from './entities/template-tier.entity';

/**
 * Deploy mode for re-applying a template's leveling config to a guild that
 * already has its own settings. Matches the spec's "Перезаписать / Сохранить
 * / Объединить" choice surfaced in the install UI.
 *
 *   - 'overwrite' → wipe destination tables for this server, then write template rows
 *   - 'keep'      → if destination already has a server_leveling_settings row, skip
 *                   the whole leveling step
 *   - 'merge'     → upsert settings, append non-conflicting tiers/rewards/no-xp
 */
export type LevelingDeployMode = 'overwrite' | 'keep' | 'merge';

export interface LevelingDeployReport {
  applied: boolean;
  reason?: 'leveling_disabled_on_template' | 'destination_kept' | 'template_settings_missing';
  summary: {
    tiers: number;
    roleRewards: number;
    noXpRoles: number;
    noXpChannels: number;
  };
  skipped: {
    roleRewardsMissingRole: string[];
    noXpRolesMissingRole: string[];
    noXpChannelsMissingChannel: string[];
    levelupChannelMissing?: string;
  };
  warnings: string[];
}

@Injectable()
export class TemplateLevelingDeployService {
  private readonly logger = new Logger(TemplateLevelingDeployService.name);

  constructor(
    @InjectRepository(TemplateLevelingSettings)
    private readonly tplSettingsRepo: Repository<TemplateLevelingSettings>,
    @InjectRepository(TemplateTier)
    private readonly tplTierRepo: Repository<TemplateTier>,
    @InjectRepository(TemplateRoleReward)
    private readonly tplRewardRepo: Repository<TemplateRoleReward>,
    @InjectRepository(TemplateNoXpRole)
    private readonly tplNoXpRoleRepo: Repository<TemplateNoXpRole>,
    @InjectRepository(TemplateNoXpChannel)
    private readonly tplNoXpChannelRepo: Repository<TemplateNoXpChannel>,

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
  ) {}

  /**
   * Apply a template's leveling block onto a guild. Caller is responsible
   * for opening the install transaction and dispatching the report.
   *
   * Resolution rules:
   *   - Role names → Discord role ids (case-sensitive exact match on guild)
   *   - Channel names → Discord channel ids (filtered by type for no-xp voice)
   *   - levelup_channel_name → live channel id if mode='channel', else 'dm' or null
   *
   * Missing references are recorded under `skipped` and propagated as
   * install warnings — they do not abort the deploy.
   */
  async install(
    guild: Guild,
    templateId: string,
    mode: LevelingDeployMode,
    templateLevelingEnabled: boolean,
  ): Promise<LevelingDeployReport> {
    const report: LevelingDeployReport = {
      applied: false,
      summary: { tiers: 0, roleRewards: 0, noXpRoles: 0, noXpChannels: 0 },
      skipped: {
        roleRewardsMissingRole: [],
        noXpRolesMissingRole: [],
        noXpChannelsMissingChannel: [],
      },
      warnings: [],
    };

    if (!templateLevelingEnabled) {
      report.reason = 'leveling_disabled_on_template';
      return report;
    }

    const tplSettings = await this.tplSettingsRepo.findOne({ where: { templateId } });
    if (!tplSettings) {
      // Owner-admin flipped the leveling flag on but never opened the editor.
      // We still deploy a "default" config so the buyer ends up with a working
      // setup — anything they edit later is theirs to own.
      report.warnings.push(
        'Template has leveling enabled but no settings row; applying defaults.',
      );
    }

    const guildId = guild.id;

    if (mode === 'keep') {
      const existing = await this.settingsRepo.findOne({ where: { serverId: guildId } });
      if (existing) {
        report.reason = 'destination_kept';
        return report;
      }
    }

    // Resolve guild role/channel name maps once — used everywhere below.
    await guild.roles.fetch().catch(() => null);
    await guild.channels.fetch().catch(() => null);
    const roleIdByName = new Map(
      guild.roles.cache
        .filter((r) => !r.managed && r.id !== guild.id)
        .map((r) => [r.name, r.id] as const),
    );
    const textChannelIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .map((c) => [c.name, c.id] as const),
    );
    const voiceChannelIdByName = new Map(
      guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
        .map((c) => [c.name, c.id] as const),
    );

    // ── Settings ────────────────────────────────────────
    const targetSettings =
      (await this.settingsRepo.findOne({ where: { serverId: guildId } })) ??
      this.settingsRepo.create({ serverId: guildId });

    let resolvedLevelupChannelId: string | null = null;
    if (tplSettings) {
      // Resolve the level-up channel using the template's chosen mode.
      if (tplSettings.levelupChannelMode === 'dm') {
        resolvedLevelupChannelId = 'dm';
      } else if (tplSettings.levelupChannelMode === 'disabled') {
        resolvedLevelupChannelId = null;
      } else if (tplSettings.levelupChannelName) {
        const found = textChannelIdByName.get(tplSettings.levelupChannelName);
        if (found) {
          resolvedLevelupChannelId = found;
        } else {
          report.skipped.levelupChannelMissing = tplSettings.levelupChannelName;
          report.warnings.push(
            `Level-up channel "${tplSettings.levelupChannelName}" not found — notifications disabled.`,
          );
        }
      }
      // Apply scalars
      targetSettings.enabled = tplSettings.enabled;
      targetSettings.levelupChannelId = resolvedLevelupChannelId;
      targetSettings.levelupMessageTemplate = tplSettings.levelupMessageTemplate;
      targetSettings.notifyOnlyNewTier = tplSettings.notifyOnlyNewTier;
      targetSettings.chatXpEnabled = tplSettings.chatXpEnabled;
      targetSettings.chatXpMin = tplSettings.chatXpMin;
      targetSettings.chatXpMax = tplSettings.chatXpMax;
      targetSettings.chatXpCooldown = tplSettings.chatXpCooldown;
      targetSettings.chatXpMinLength = tplSettings.chatXpMinLength;
      targetSettings.voiceXpEnabled = tplSettings.voiceXpEnabled;
      targetSettings.voiceXpPerMinute = tplSettings.voiceXpPerMinute;
      targetSettings.voiceXpMinUsers = tplSettings.voiceXpMinUsers;
      targetSettings.voiceXpAfkMinutes = tplSettings.voiceXpAfkMinutes;
      targetSettings.roleRewardsMode = tplSettings.roleRewardsMode;
      targetSettings.rankBgImageUrl = tplSettings.rankBgImageUrl;
      targetSettings.rankBgColor = tplSettings.rankBgColor;
      targetSettings.rankOverlayOpacity = tplSettings.rankOverlayOpacity;
      targetSettings.rankPrimaryTextColor = tplSettings.rankPrimaryTextColor;
      targetSettings.rankSecondaryTextColor = tplSettings.rankSecondaryTextColor;
      targetSettings.rankAccentColor = tplSettings.rankAccentColor;
      targetSettings.rankProgressColor = tplSettings.rankProgressColor;
      targetSettings.rankProgressBgColor = tplSettings.rankProgressBgColor;
    } else {
      // Defaults — entity-level defaults are enough, just flip enabled on.
      targetSettings.enabled = true;
    }
    await this.settingsRepo.save(targetSettings);

    // ── Tiers ───────────────────────────────────────────
    const tplTiers = await this.tplTierRepo.find({ where: { templateId } });
    if (mode === 'overwrite') {
      await this.tierRepo.delete({ serverId: guildId });
    }
    if (mode === 'merge') {
      // For merge, drop tiers only when the template has its own non-empty set —
      // we want the template's ladder to win over any partial defaults that
      // might have been seeded by getSettings() during MVP usage.
      if (tplTiers.length) {
        await this.tierRepo.delete({ serverId: guildId });
      }
    }
    const tierRows = tplTiers
      .slice()
      .sort((a, b) => a.startLevel - b.startLevel)
      .map((t, i) =>
        this.tierRepo.create({
          serverId: guildId,
          name: t.name,
          emoji: t.emoji,
          iconUrl: t.iconUrl,
          startLevel: t.startLevel,
          endLevel: t.endLevel,
          color: t.color,
          levelupMessage: t.levelupMessage,
          sortOrder: i,
        }),
      );
    if (tierRows.length) await this.tierRepo.save(tierRows);
    report.summary.tiers = tierRows.length;

    // ── Role rewards ────────────────────────────────────
    const tplRewards = await this.tplRewardRepo.find({ where: { templateId } });
    if (mode === 'overwrite') {
      await this.rewardRepo.delete({ serverId: guildId });
    }
    for (const r of tplRewards) {
      const roleId = roleIdByName.get(r.roleName);
      if (!roleId) {
        report.skipped.roleRewardsMissingRole.push(`${r.roleName} (level ${r.level})`);
        continue;
      }
      if (mode === 'merge') {
        const exists = await this.rewardRepo.findOne({
          where: { serverId: guildId, level: r.level },
        });
        if (exists) continue;
      }
      await this.rewardRepo.save(
        this.rewardRepo.create({ serverId: guildId, level: r.level, roleId }),
      );
      report.summary.roleRewards += 1;
    }
    if (report.skipped.roleRewardsMissingRole.length) {
      report.warnings.push(
        `Role rewards skipped (role not found): ${report.skipped.roleRewardsMissingRole.join(', ')}`,
      );
    }

    // ── No-XP roles ─────────────────────────────────────
    const tplNoRoles = await this.tplNoXpRoleRepo.find({ where: { templateId } });
    if (mode === 'overwrite') {
      await this.noXpRoleRepo.delete({ serverId: guildId });
    }
    for (const r of tplNoRoles) {
      const roleId = roleIdByName.get(r.roleName);
      if (!roleId) {
        report.skipped.noXpRolesMissingRole.push(r.roleName);
        continue;
      }
      try {
        await this.noXpRoleRepo.save(
          this.noXpRoleRepo.create({ serverId: guildId, roleId }),
        );
        report.summary.noXpRoles += 1;
      } catch {
        // unique conflict in merge mode — already present
      }
    }
    if (report.skipped.noXpRolesMissingRole.length) {
      report.warnings.push(
        `No-XP roles skipped (role not found): ${report.skipped.noXpRolesMissingRole.join(', ')}`,
      );
    }

    // ── No-XP channels ──────────────────────────────────
    const tplNoChannels = await this.tplNoXpChannelRepo.find({ where: { templateId } });
    if (mode === 'overwrite') {
      await this.noXpChannelRepo.delete({ serverId: guildId });
    }
    for (const c of tplNoChannels) {
      const map = c.channelType === 'voice' ? voiceChannelIdByName : textChannelIdByName;
      const channelId = map.get(c.channelName);
      if (!channelId) {
        report.skipped.noXpChannelsMissingChannel.push(`#${c.channelName} (${c.channelType})`);
        continue;
      }
      try {
        await this.noXpChannelRepo.save(
          this.noXpChannelRepo.create({
            serverId: guildId,
            channelId,
            channelType: c.channelType,
          }),
        );
        report.summary.noXpChannels += 1;
      } catch {
        // unique conflict in merge mode
      }
    }
    if (report.skipped.noXpChannelsMissingChannel.length) {
      report.warnings.push(
        `No-XP channels skipped (channel not found): ${report.skipped.noXpChannelsMissingChannel.join(', ')}`,
      );
    }

    report.applied = true;
    return report;
  }
}
