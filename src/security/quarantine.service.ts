import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { Button, Context, On } from 'necord';
import type { ButtonContext, ContextOf } from 'necord';

import { SecurityBridge } from '../common/security-bridge.service';
import { QuarantineRecord, SecuritySettings } from './entities/security.entities';
import { SecurityService } from './security.service';

const ROLE_NAME = 'Quarantined';
const CHANNEL_NAME = 'quarantine-review';

/**
 * Quarantine (§6): a no-permission role + a review channel; quarantined
 * members see ONLY #quarantine-review, their roles are saved and restored
 * on Approve. Review cards carry Approve/Kick/Ban buttons (owner+whitelist).
 */
@Injectable()
export class QuarantineService implements OnModuleInit {
  private readonly logger = new Logger(QuarantineService.name);

  constructor(
    @InjectRepository(QuarantineRecord)
    private readonly recordRepo: Repository<QuarantineRecord>,
    private readonly security: SecurityService,
    private readonly bridge: SecurityBridge,
    @Inject(Client) private readonly client: Client,
  ) {}

  onModuleInit(): void {
    this.security.quarantineHook = (member, reason, source) =>
      this.quarantine(member, reason, source).then((r) => r.ok);
    this.bridge.isQuarantined = (member) => this.isQuarantinedSync(member);
  }

  /** §6.4 — sync check by role (welcome/XP hot paths). */
  private isQuarantinedSync(member: GuildMember): boolean {
    return member.roles.cache.some((r) => r.name === ROLE_NAME);
  }

  // ── §6.1 Setup ──────────────────────────────────────────

  async setup(guild: Guild): Promise<{ ok: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    const settings = await this.security.getSettings(guild.id);

    let role = settings.quarantineRoleId ? guild.roles.cache.get(settings.quarantineRoleId) : undefined;
    role ??= guild.roles.cache.find((r) => r.name === ROLE_NAME);
    if (!role) {
      role = await guild.roles.create({
        name: ROLE_NAME,
        color: 0x808080,
        permissions: [],
        reason: 'Security Suite: quarantine setup',
      });
    }

    let channel = settings.quarantineChannelId
      ? (guild.channels.cache.get(settings.quarantineChannelId) as TextChannel | undefined)
      : undefined;
    channel ??= guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === CHANNEL_NAME,
    ) as TextChannel | undefined;
    if (!channel) {
      channel = await guild.channels.create({
        name: CHANNEL_NAME,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ...(this.client.user
            ? [{ id: this.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }]
            : []),
        ],
        reason: 'Security Suite: quarantine setup',
      });
    }

    // Deny ViewChannel for Quarantined on every existing channel except review.
    let overridden = 0;
    for (const ch of guild.channels.cache.values()) {
      if (ch.id === channel.id) continue;
      if (!('permissionOverwrites' in ch)) continue;
      await ch.permissionOverwrites
        .edit(role.id, { ViewChannel: false }, { reason: 'Quarantine isolation' })
        .then(() => (overridden += 1))
        .catch(() => null);
    }

    // §6.5 — hierarchy check.
    const me = guild.members.me;
    if (me && role.position >= me.roles.highest.position) {
      warnings.push('Bot role must be ABOVE the Quarantined role — move it up in Server Settings → Roles.');
    }

    settings.quarantineRoleId = role.id;
    settings.quarantineChannelId = channel.id;
    await this.security.saveSettings(settings);
    this.logger.log(`Quarantine set up in ${guild.id}: role ${role.id}, channel ${channel.id}, ${overridden} overrides`);
    return { ok: true, warnings };
  }

  /** §6.1 — keep new channels hidden from quarantined members. */
  @On('channelCreate')
  async onChannelCreate(@Context() [ch]: ContextOf<'channelCreate'>) {
    try {
      if (!('guild' in ch) || !ch.guild) return;
      const settings = await this.security.getSettings(ch.guild.id);
      if (!settings.quarantineRoleId || ch.id === settings.quarantineChannelId) return;
      if (!ch.guild.roles.cache.has(settings.quarantineRoleId)) return;
      await ch.permissionOverwrites
        .edit(settings.quarantineRoleId, { ViewChannel: false }, { reason: 'Quarantine isolation' })
        .catch(() => null);
    } catch {
      /* isolation is best-effort for new channels */
    }
  }

  // ── §6.2 Quarantining ───────────────────────────────────

  async quarantine(member: GuildMember, reason: string, source: string): Promise<{ ok: boolean; note?: string }> {
    const guild = member.guild;
    if (!(await this.security.isPremium(guild.id))) return { ok: false, note: 'Premium required' };
    const settings = await this.security.getSettings(guild.id);
    if (!settings.quarantineRoleId || !guild.roles.cache.has(settings.quarantineRoleId)) {
      return { ok: false, note: 'Quarantine is not set up' };
    }
    if (member.id === guild.ownerId) return { ok: false, note: 'Cannot quarantine the owner' };
    if (this.isQuarantinedSync(member)) return { ok: true, note: 'Already quarantined' };

    const originalRoleIds = [...member.roles.cache.filter((r) => r.id !== guild.id).keys()];
    try {
      await member.roles.set([settings.quarantineRoleId], `Quarantine: ${reason}`);
    } catch (e) {
      return { ok: false, note: `Role change failed: ${(e as Error).message}` };
    }

    const record = await this.recordRepo.save(
      this.recordRepo.create({ guildId: guild.id, userId: member.id, originalRoleIds, reason, source }),
    );
    await this.postReviewCard(guild, member, record).catch((e) =>
      this.logger.warn(`review card failed: ${(e as Error).message}`),
    );
    return { ok: true };
  }

  private async postReviewCard(guild: Guild, member: GuildMember, record: QuarantineRecord): Promise<void> {
    const settings = await this.security.getSettings(guild.id);
    if (!settings.quarantineChannelId) return;
    const channel = guild.channels.cache.get(settings.quarantineChannelId);
    if (!channel?.isTextBased()) return;

    const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('🧪 Quarantined member')
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
        { name: 'Account age', value: `${ageDays} day(s)`, inline: true },
        { name: 'Reason', value: record.reason ?? '—', inline: false },
        { name: 'Source', value: record.source, inline: true },
      )
      .setTimestamp(new Date());
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`sec/q-approve/${record.id}`).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sec/q-kick/${record.id}`).setLabel('👢 Kick').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`sec/q-ban/${record.id}`).setLabel('🔨 Ban').setStyle(ButtonStyle.Danger),
    );
    const msg = await (channel as TextChannel).send({ embeds: [embed], components: [row] });
    record.reviewMessageId = msg.id;
    await this.recordRepo.save(record);
  }

  // ── §6.3 Review actions ─────────────────────────────────

  @Button('sec/q-approve/:recordId')
  async onApprove(@Context() [interaction]: ButtonContext) {
    await this.review(interaction, 'approve');
  }

  @Button('sec/q-kick/:recordId')
  async onKick(@Context() [interaction]: ButtonContext) {
    await this.review(interaction, 'kick');
  }

  @Button('sec/q-ban/:recordId')
  async onBan(@Context() [interaction]: ButtonContext) {
    await this.review(interaction, 'ban');
  }

  private async review(interaction: ButtonContext[0], action: 'approve' | 'kick' | 'ban'): Promise<void> {
    const guild = interaction.guild;
    if (!guild) return;
    if (!(await this.security.canUseButtons(guild, interaction.user.id))) {
      await interaction.reply({ content: "You don't have permission.", ephemeral: true });
      return;
    }
    const recordId = interaction.customId.split('/').pop()!;
    const record = await this.recordRepo.findOne({ where: { id: recordId, guildId: guild.id } });
    if (!record || record.status !== 'active') {
      await interaction.reply({ content: 'This case is already closed.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();

    const member = await guild.members.fetch(record.userId).catch(() => null);
    let note = '';
    if (action === 'approve') {
      if (member) {
        const roles = record.originalRoleIds.filter((id) => guild.roles.cache.has(id));
        await member.roles.set(roles, 'Quarantine approved').catch(() => null);
        note = 'Roles restored.';
      } else note = 'Member already left; record closed.';
      record.status = 'approved';
    } else if (action === 'kick') {
      await member?.kick('Quarantine review: kick').catch(() => null);
      record.status = 'kicked';
      note = 'Member kicked.';
    } else {
      await guild.members.ban(record.userId, { reason: 'Quarantine review: ban' }).catch(() => null);
      record.status = 'banned';
      note = 'Member banned.';
    }
    await this.recordRepo.save(record);

    // Disable buttons + append the outcome (§7 pattern).
    const msg = interaction.message;
    const embed = EmbedBuilder.from(msg.embeds[0]).addFields({
      name: 'Resolution',
      value: `${action.toUpperCase()} by ${interaction.user.tag} — ${note}`,
    });
    await msg.edit({ embeds: [embed], components: [] }).catch(() => null);
  }

  // ── Data access for REST ────────────────────────────────

  listActive(guildId: string): Promise<QuarantineRecord[]> {
    return this.recordRepo.find({ where: { guildId, status: 'active' }, order: { createdAt: 'DESC' } });
  }

  /** Manual actions from the dashboard mirror the button flow. */
  async resolveFromDashboard(guildId: string, recordId: string, action: 'approve' | 'kick' | 'ban'): Promise<void> {
    const guild = this.client.guilds.cache.get(guildId);
    const record = await this.recordRepo.findOne({ where: { id: recordId, guildId } });
    if (!guild || !record || record.status !== 'active') return;
    const member = await guild.members.fetch(record.userId).catch(() => null);
    if (action === 'approve') {
      if (member) {
        const roles = record.originalRoleIds.filter((id) => guild.roles.cache.has(id));
        await member.roles.set(roles, 'Quarantine approved').catch(() => null);
      }
      record.status = 'approved';
    } else if (action === 'kick') {
      await member?.kick('Quarantine review: kick').catch(() => null);
      record.status = 'kicked';
    } else {
      await guild.members.ban(record.userId, { reason: 'Quarantine review: ban' }).catch(() => null);
      record.status = 'banned';
    }
    await this.recordRepo.save(record);
  }
}
