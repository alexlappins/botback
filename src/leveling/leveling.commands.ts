import { Injectable } from '@nestjs/common';
import {
  Button,
  ComponentParam,
  Context,
  createCommandGroupDecorator,
  IntegerOption,
  Options,
  SlashCommand,
  Subcommand,
  UserOption,
} from 'necord';
import type { ButtonContext, SlashCommandContext } from 'necord';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
} from 'discord.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LevelingService } from './leveling.service';
import { IgnoredUser } from './entities/ignored-user.entity';

/** Leaderboard button custom-id prefix: `lvlb/<scope>/<page>`. */
const LB_PREFIX = 'lvlb';
const LB_PAGE_SIZE = 10;
const LB_MAX_PAGE = 10; // 100 positions per spec

// ── Shared DTOs ─────────────────────────────────────────

class UserDto {
  @UserOption({ name: 'user', description: 'Target user', required: false })
  user?: { id: string; username: string; bot?: boolean };
}

class UserAmountDto {
  @UserOption({ name: 'user', description: 'Target user', required: true })
  user: { id: string; username: string };

  @IntegerOption({ name: 'amount', description: 'XP amount', required: true, min_value: 1 })
  amount: number;
}

class UserSetDto {
  @UserOption({ name: 'user', description: 'Target user', required: true })
  user: { id: string; username: string };

  @IntegerOption({ name: 'amount', description: 'XP amount', required: true, min_value: 0 })
  amount: number;
}

class IgnoreDto {
  @UserOption({ name: 'user', description: 'Target user', required: true })
  user: { id: string; username: string };

  @IntegerOption({
    name: 'action',
    description: 'Add to ignore list (1) or remove (0)',
    required: false,
    choices: [
      { name: 'add', value: 1 },
      { name: 'remove', value: 0 },
    ],
  })
  action?: number;
}

class LeaderboardDto {
  @IntegerOption({
    name: 'scope',
    description: 'all-time (default) or monthly',
    required: false,
    choices: [
      { name: 'all-time', value: 0 },
      { name: 'monthly', value: 1 },
    ],
  })
  scope?: number;

  @IntegerOption({
    name: 'page',
    description: 'Page (10 per page, default 1)',
    required: false,
    min_value: 1,
    max_value: 10,
  })
  page?: number;
}

// ── /rank + /leaderboard (public) ───────────────────────

@Injectable()
export class LevelingPublicCommands {
  constructor(private readonly leveling: LevelingService) {}

  @SlashCommand({ name: 'rank', description: 'Show your (or another user’s) rank' })
  async onRank(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: UserDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply();

    const targetId = dto.user?.id ?? interaction.user.id;
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const username = member?.user.username ?? dto.user?.username ?? interaction.user.username;
    const avatarUrl =
      member?.user.displayAvatarURL({ extension: 'png', size: 256 }) ??
      `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(targetId) % 5n)}.png`;

    const png = await this.leveling.renderRankCard({
      serverId: interaction.guildId,
      memberId: targetId,
      username,
      avatarUrl,
    });

    if (png) {
      const file = new AttachmentBuilder(png, { name: `rank-${targetId}.png` });
      return interaction.editReply({ files: [file] });
    }

    // Fallback to embed if rendering failed (canvas error, OOM, missing native binary).
    const xp = await this.leveling.getOrCreateXp(interaction.guildId, targetId);
    const tiers = await this.leveling.getTiers(interaction.guildId);
    const tier = this.leveling.resolveTier(tiers, xp.level);
    const rank = await this.leveling.rankPosition(interaction.guildId, targetId, 'all');
    const embed = new EmbedBuilder()
      .setTitle(`${username} — Level ${xp.level}`)
      .setColor((tier?.color as `#${string}`) ?? '#8b5cf6')
      .addFields(
        { name: 'XP', value: formatBigint(xp.totalXp), inline: true },
        { name: 'Rank', value: `#${rank || '—'}`, inline: true },
        { name: 'Tier', value: tier ? `${tier.emoji ?? ''} ${tier.name}`.trim() : '—', inline: true },
      );
    return interaction.editReply({ embeds: [embed] });
  }

  @SlashCommand({ name: 'leaderboard', description: 'Server leaderboard' })
  async onLeaderboard(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LeaderboardDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply();
    const scope: 'all' | 'monthly' = dto.scope === 1 ? 'monthly' : 'all';
    const page = Math.max(1, Math.min(LB_MAX_PAGE, dto.page ?? 1));
    const payload = await renderLeaderboard(this.leveling, interaction, scope, page);
    return interaction.editReply(payload as InteractionEditReplyOptions);
  }
}

// ── Button-driven leaderboard pagination ──────────────────
// Custom IDs: `lvlb/all/2`, `lvlb/monthly/1`. Anyone in the guild can click
// these (Discord enforces only that the user is in the guild) — pagination
// has no permission gate, mirroring how Probot/Arcane work.

@Injectable()
export class LevelingLeaderboardComponents {
  constructor(private readonly leveling: LevelingService) {}

  @Button(`${LB_PREFIX}/:scope/:page`)
  async onLeaderboardNav(
    @Context() [interaction]: ButtonContext,
    @ComponentParam('scope') scopeRaw: string,
    @ComponentParam('page') pageRaw: string,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    const scope: 'all' | 'monthly' = scopeRaw === 'monthly' ? 'monthly' : 'all';
    const page = Math.max(1, Math.min(LB_MAX_PAGE, Number(pageRaw) || 1));
    await interaction.deferUpdate();
    const payload = await renderLeaderboard(this.leveling, interaction, scope, page);
    await interaction.editReply(payload as InteractionEditReplyOptions);
  }
}

/**
 * Render the leaderboard payload (embed + Prev/Next/scope-toggle row).
 * Shared between the slash command and the button handler so we don't drift.
 *
 * `Math.ceil(total / pageSize)` drives Next-disable; we still clamp to
 * `LB_MAX_PAGE` because the spec caps pagination at 100 positions.
 */
async function renderLeaderboard(
  leveling: LevelingService,
  interaction: ChatInputCommandInteraction | ButtonContext[0],
  scope: 'all' | 'monthly',
  page: number,
): Promise<InteractionReplyOptions & InteractionEditReplyOptions> {
  const guild = interaction.guild!;
  const guildId = interaction.guildId!;
  const offset = (page - 1) * LB_PAGE_SIZE;
  const rows = await leveling.leaderboard(guildId, scope, LB_PAGE_SIZE, offset);
  const totalCount = await leveling.leaderboardCount(guildId, scope);
  const totalPages = Math.max(1, Math.min(LB_MAX_PAGE, Math.ceil(totalCount / LB_PAGE_SIZE)));

  const title =
    scope === 'monthly'
      ? `🏆 Monthly Leaderboard — ${guild.name}`
      : `🏆 Leaderboard — ${guild.name}`;

  if (!rows.length) {
    return {
      content:
        scope === 'monthly'
          ? 'Никого нет в monthly-лидерборде. Поактивничайте чуть-чуть!'
          : 'Лидерборд пуст — пока никто не накапливал XP.',
      embeds: [],
      components: [buildLeaderboardRow(scope, page, totalPages)],
    };
  }

  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const place = offset + i + 1;
    const xp = scope === 'monthly' ? r.monthlyXp : r.totalXp;
    lines.push(`**#${place}** <@${r.discordId}> — \`Lv ${r.level}\` · ${formatBigint(xp)} XP`);
  }
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor('#8b5cf6')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Page ${page} / ${totalPages}  ·  ${totalCount.toLocaleString('en-US')} ranked members` });

  return {
    embeds: [embed],
    content: '',
    components: [buildLeaderboardRow(scope, page, totalPages)],
  };
}

function buildLeaderboardRow(
  scope: 'all' | 'monthly',
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  const prev = new ButtonBuilder()
    .setCustomId(`${LB_PREFIX}/${scope}/${Math.max(1, page - 1)}`)
    .setLabel('◀')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page <= 1);

  const toggleScope: 'all' | 'monthly' = scope === 'monthly' ? 'all' : 'monthly';
  const toggle = new ButtonBuilder()
    .setCustomId(`${LB_PREFIX}/${toggleScope}/1`)
    .setLabel(scope === 'monthly' ? 'All-time' : 'Monthly')
    .setStyle(ButtonStyle.Primary);

  const next = new ButtonBuilder()
    .setCustomId(`${LB_PREFIX}/${scope}/${Math.min(totalPages, page + 1)}`)
    .setLabel('▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= totalPages);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(prev, toggle, next);
}

// ── /xp <subcommands> (moderators) ──────────────────────

const XpGroup = createCommandGroupDecorator({
  name: 'xp',
  description: 'Manage XP (moderators only)',
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
});

@XpGroup()
@Injectable()
export class XpAdminCommands {
  constructor(
    private readonly leveling: LevelingService,
    @InjectRepository(IgnoredUser)
    private readonly ignoredRepo: Repository<IgnoredUser>,
  ) {}

  @Subcommand({ name: 'give', description: 'Add XP to a user' })
  async onGive(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: UserAmountDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await this.leveling.awardXp(
      interaction.guildId,
      dto.user.id,
      dto.amount,
      'admin_give',
    );
    if (result.leveledUp) {
      const member = await interaction.guild.members.fetch(dto.user.id).catch(() => null);
      if (member) await this.leveling.handleLevelUp(interaction.guild, member, result);
    }
    return interaction.editReply(
      `Выдано **${dto.amount} XP** пользователю <@${dto.user.id}>. Теперь: ${result.newTotal} XP, level ${result.newLevel}.`,
    );
  }

  @Subcommand({ name: 'remove', description: 'Take XP from a user' })
  async onRemove(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: UserAmountDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const result = await this.leveling.awardXp(
      interaction.guildId,
      dto.user.id,
      -dto.amount,
      'admin_remove',
    );
    const member = await interaction.guild.members.fetch(dto.user.id).catch(() => null);
    const settings = await this.leveling.getSettings(interaction.guildId);
    if (member) await this.leveling.applyRoleRewards(member, settings.roleRewardsMode);
    return interaction.editReply(
      `Снято **${dto.amount} XP** у <@${dto.user.id}>. Теперь: ${result.newTotal} XP, level ${result.newLevel}.`,
    );
  }

  @Subcommand({ name: 'set', description: 'Set a user’s XP to an exact value' })
  async onSet(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: UserSetDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const row = await this.leveling.getOrCreateXp(interaction.guildId, dto.user.id);
    const delta = dto.amount - Number(row.totalXp);
    const result = await this.leveling.awardXp(
      interaction.guildId,
      dto.user.id,
      delta,
      'admin_set',
    );
    const member = await interaction.guild.members.fetch(dto.user.id).catch(() => null);
    if (member) {
      const settings = await this.leveling.getSettings(interaction.guildId);
      await this.leveling.applyRoleRewards(member, settings.roleRewardsMode);
    }
    return interaction.editReply(
      `XP пользователя <@${dto.user.id}> установлен в **${dto.amount}** (level ${result.newLevel}).`,
    );
  }

  @Subcommand({ name: 'reset', description: 'Reset a user’s XP to 0 (revokes reward roles)' })
  async onReset(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: UserDto,
  ) {
    if (!interaction.guildId || !interaction.guild) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    if (!dto.user) {
      return interaction.reply({ content: 'Укажи пользователя для сброса.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch(dto.user.id).catch(() => null);
    if (member) await this.leveling.stripAllRewardRoles(member);
    await this.leveling.resetUser(interaction.guildId, dto.user.id);
    return interaction.editReply(`XP пользователя <@${dto.user.id}> сброшен в 0.`);
  }

  @Subcommand({ name: 'ignore', description: 'Add/remove a user from the XP ignore list' })
  async onIgnore(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: IgnoreDto,
  ) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const action = dto.action ?? 1;
    if (action === 1) {
      const row = this.ignoredRepo.create({
        serverId: interaction.guildId,
        discordId: dto.user.id,
      });
      try {
        await this.ignoredRepo.save(row);
      } catch {
        // unique conflict — already ignored
      }
      return interaction.editReply(`<@${dto.user.id}> добавлен в ignore-list (XP не начисляется).`);
    }
    await this.ignoredRepo.delete({ serverId: interaction.guildId, discordId: dto.user.id });
    return interaction.editReply(`<@${dto.user.id}> убран из ignore-list.`);
  }

  @Subcommand({ name: 'recalc', description: 'Recompute levels and tiers for all members' })
  async onRecalc(@Context() [interaction]: SlashCommandContext) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const { updated } = await this.leveling.recalcServer(interaction.guildId);
    return interaction.editReply(`Пересчёт выполнен. Обновлено записей: **${updated}**.`);
  }
}

function progressBar(percent: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return `\`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` ${percent}%`;
}

// TypeORM returns Postgres bigint as a string; format it for embed display
// (locale grouping for big numbers — 1,234,567 reads better than 1234567).
function formatBigint(v: string | number | bigint): string {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US');
}
