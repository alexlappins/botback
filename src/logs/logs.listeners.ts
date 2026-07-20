import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Context, On } from 'necord';
import type { ContextOf } from 'necord';
import {
  AttachmentBuilder,
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildChannel,
  PermissionsBitField,
  TextChannel,
} from 'discord.js';

import { SecurityBridge } from '../common/security-bridge.service';
import { WebhookCache } from '../personalization/entities/webhook-cache.entity';
import { LogEventsService } from './log-events.service';
import { LogSettingsService } from './log-settings.service';
import { AuditLookupService } from './audit-lookup.service';
import { MessageCacheService } from './message-cache.service';
import { InviteTrackerService } from './invite-tracker.service';
import { AlertsService } from './alerts.service';
import { ALERTS_CONFIG } from './alerts.config';
import type { LogPreset } from './log-presets';

/**
 * Server Logs 2.0 listeners (TZ §1): ONE gateway subscription feeding both
 * the preset log embeds and the Server Alerts detectors (TZ §7 — no second
 * listener). Bot-authored messages are not logged; our own bot's actions are
 * ignored by all detectors.
 */
@Injectable()
export class LogsListeners {
  private readonly logger = new Logger(LogsListeners.name);
  /** Webhook ids we've already seen per guild (D6 anti-retrigger). */
  private seenWebhooks = new Map<string, Set<string>>();

  constructor(
    private readonly logEvents: LogEventsService,
    private readonly settings: LogSettingsService,
    private readonly audit: AuditLookupService,
    private readonly msgCache: MessageCacheService,
    private readonly invites: InviteTrackerService,
    private readonly alerts: AlertsService,
    private readonly securityBridge: SecurityBridge,
    @Inject(Client) private readonly client: Client,
    @InjectRepository(WebhookCache)
    private readonly webhookCacheRepo: Repository<WebhookCache>,
  ) {}

  /** Send an embed to the preset's channel (silently skips when off). */
  private async sendLog(guild: Guild, preset: LogPreset, embed: EmbedBuilder, files?: AttachmentBuilder[]) {
    try {
      const channelId = this.settings.channelFor(guild.id, preset);
      if (!channelId) return;
      const channel = guild.channels.cache.get(channelId);
      if (!channel?.isTextBased()) return;
      await (channel as TextChannel).send({ embeds: [embed], files });
    } catch (e) {
      this.logger.debug(`sendLog(${preset}) failed: ${(e as Error).message}`);
    }
  }

  private baseEmbed(color: number, title: string): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setTimestamp(new Date());
  }

  private executorLine(tag: string | null | undefined): string {
    return tag ?? 'Unknown (author or unavailable)';
  }

  // ═══════════════ Preset 2: JOIN/LEAVE ═══════════════

  @On('guildMemberAdd')
  async onMemberJoin(@Context() [member]: ContextOf<'guildMemberAdd'>) {
    const guild = member.guild;

    // Bot added → Server preset + D7 (TZ preset 6).
    if (member.user.bot) {
      const entry = await this.audit.lookup(guild, AuditLogEvent.BotAdd, member.id);
      const inviterTag = entry?.executor?.tag ?? null;
      const embed = this.baseEmbed(0xfee75c, 'Bot added')
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Bot', value: member.user.tag, inline: true },
          { name: 'Added by', value: this.executorLine(inviterTag), inline: true },
        );
      await this.sendLog(guild, 'server', embed);
      this.alerts.onMemberJoin(guild, member.id, member.user.tag, member.user.createdTimestamp, true, inviterTag);
      return;
    }

    // §2.2 Security pipeline: Age Filter runs FIRST; a kick stops everything.
    const verdict = await this.securityBridge.gateJoin(member).catch(() => 'allow' as const);
    if (verdict === 'kick') return;

    const invite = await this.invites.resolveJoin(guild).catch(() => null);
    const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);

    await this.logEvents.create({
      guildId: guild.id,
      type: 'joinLeave',
      kind: 'member_join',
      payload: {
        userId: member.user.id,
        userTag: member.user.tag,
        avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      },
    });

    const embed = this.baseEmbed(0x57f287, 'Member joined')
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'User', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
        { name: 'Account age', value: `${accountAgeDays} day(s)`, inline: true },
        ...(invite
          ? [
              {
                name: 'Invite',
                value: `\`${invite.code}\`${invite.inviterTag ? ` by ${invite.inviterTag}` : ''}`,
                inline: true,
              },
            ]
          : []),
      );
    await this.sendLog(guild, 'joinLeave', embed);

    this.alerts.onMemberJoin(guild, member.id, member.user.tag, member.user.createdTimestamp, false);
  }

  @On('guildMemberRemove')
  async onMemberLeave(@Context() [member]: ContextOf<'guildMemberRemove'>) {
    const guild = member.guild;

    // Kick vs voluntary leave (TZ preset 2): audit entry within the window.
    const kickEntry = await this.audit.lookup(guild, AuditLogEvent.MemberKick, member.id);

    const roles = member.roles?.cache
      ?.filter((r) => r.id !== guild.id)
      .map((r) => r.name)
      .slice(0, 15)
      .join(', ');
    const stayed = member.joinedTimestamp
      ? `${Math.max(1, Math.floor((Date.now() - member.joinedTimestamp) / 86_400_000))} day(s)`
      : 'unknown';

    if (kickEntry) {
      await this.logEvents.create({
        guildId: guild.id,
        type: 'banKick',
        kind: 'member_kick',
        payload: {
          userId: member.id,
          userTag: member.user?.tag ?? 'Unknown',
          executorTag: kickEntry.executor?.tag ?? 'Unknown',
          reason: kickEntry.reason ?? 'Not specified',
        },
      });
      const embed = this.baseEmbed(0xe67e22, 'Member kicked')
        .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
        .addFields(
          { name: 'User', value: member.user?.tag ?? 'Unknown', inline: true },
          { name: 'Kicked by', value: this.executorLine(kickEntry.executor?.tag), inline: true },
          { name: 'Reason', value: kickEntry.reason?.slice(0, 500) ?? 'Not specified', inline: false },
          { name: 'Time on server', value: stayed, inline: true },
          ...(roles ? [{ name: 'Had roles', value: roles, inline: false }] : []),
        );
      await this.sendLog(guild, 'joinLeave', embed);
      this.alerts.onModPunishment(guild, 'kick', kickEntry.executor?.id ?? null, kickEntry.executor?.tag ?? null);
      return;
    }

    await this.logEvents.create({
      guildId: guild.id,
      type: 'joinLeave',
      kind: 'member_leave',
      payload: {
        userId: member.id,
        userTag: member.user?.tag ?? 'Unknown',
        avatarUrl: member.user?.displayAvatarURL?.({ size: 128 }) ?? undefined,
      },
    });
    const embed = this.baseEmbed(0xed4245, 'Member left')
      .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
      .addFields(
        { name: 'User', value: member.user?.tag ?? 'Unknown', inline: true },
        { name: 'Time on server', value: stayed, inline: true },
        ...(roles ? [{ name: 'Had roles', value: roles, inline: false }] : []),
      );
    await this.sendLog(guild, 'joinLeave', embed);

    this.alerts.onMemberLeave(guild);
  }

  // ═══════════════ Preset 1: BAN/UNBAN + timeouts ═══════════════

  @On('guildBanAdd')
  async onBanAdd(@Context() [ban]: ContextOf<'guildBanAdd'>) {
    const entry = await this.audit.lookup(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    await this.logEvents.create({
      guildId: ban.guild.id,
      type: 'banKick',
      kind: 'ban_add',
      payload: {
        userId: ban.user.id,
        userTag: ban.user.tag,
        reason: ban.reason ?? entry?.reason ?? 'Not specified',
      },
    });
    const embed = this.baseEmbed(0xed4245, 'Member banned')
      .setThumbnail(ban.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'User', value: ban.user.tag, inline: true },
        { name: 'Banned by', value: this.executorLine(entry?.executor?.tag), inline: true },
        { name: 'Reason', value: (ban.reason ?? entry?.reason ?? 'Not specified').slice(0, 500), inline: false },
      );
    await this.sendLog(ban.guild, 'ban', embed);

    this.alerts.onModPunishment(ban.guild, 'ban', entry?.executor?.id ?? null, entry?.executor?.tag ?? null);
  }

  @On('guildBanRemove')
  async onBanRemove(@Context() [ban]: ContextOf<'guildBanRemove'>) {
    const entry = await this.audit.lookup(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const embed = this.baseEmbed(0x57f287, 'Member unbanned')
      .setThumbnail(ban.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'User', value: ban.user.tag, inline: true },
        { name: 'Unbanned by', value: this.executorLine(entry?.executor?.tag), inline: true },
      );
    await this.sendLog(ban.guild, 'ban', embed);
  }

  // ═══════════════ Preset 4: MODERATION + timeouts/roles/nick ═══════════════

  @On('guildMemberUpdate')
  async onMemberUpdate(@Context() [oldMember, newMember]: ContextOf<'guildMemberUpdate'>) {
    const guild = newMember.guild;

    // Timeouts → BAN preset (TZ preset 1).
    const oldUntil = oldMember.communicationDisabledUntil?.getTime() ?? null;
    const newUntil = newMember.communicationDisabledUntil?.getTime() ?? null;
    if (oldUntil !== newUntil) {
      const applied = Boolean(newUntil && newUntil > Date.now());
      await this.logEvents.create({
        guildId: guild.id,
        type: 'moderation',
        kind: applied ? 'timeout' : 'timeout_remove',
        payload: {
          userId: newMember.id,
          userTag: newMember.user.tag,
          ...(applied ? { untilTimestamp: Math.floor((newUntil as number) / 1000) } : {}),
        },
      });
      const embed = this.baseEmbed(applied ? 0xfee75c : 0x57f287, applied ? 'Timeout applied' : 'Timeout removed')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'User', value: newMember.user.tag, inline: true },
          ...(applied
            ? [{ name: 'Until', value: `<t:${Math.floor((newUntil as number) / 1000)}:F>`, inline: true }]
            : []),
        );
      await this.sendLog(guild, 'ban', embed);
    }

    // Nickname change (moderation preset).
    if (oldMember.nickname !== newMember.nickname) {
      const entry = await this.audit.lookup(guild, AuditLogEvent.MemberUpdate, newMember.id);
      const embed = this.baseEmbed(0x5865f2, 'Nickname changed')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'User', value: newMember.user.tag, inline: true },
          { name: 'Before', value: oldMember.nickname ?? '(none)', inline: true },
          { name: 'After', value: newMember.nickname ?? '(none)', inline: true },
          { name: 'Changed by', value: this.executorLine(entry?.executor?.tag), inline: true },
        );
      await this.sendLog(guild, 'moderation', embed);
    }

    // Role add/remove (moderation preset) + D4 dangerous grants.
    const oldRoles = new Set(oldMember.roles.cache.keys());
    const newRoles = new Set(newMember.roles.cache.keys());
    const added = [...newRoles].filter((r) => !oldRoles.has(r));
    const removed = [...oldRoles].filter((r) => !newRoles.has(r));
    if (added.length || removed.length) {
      const entry = await this.audit.lookup(guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
      const fmt = (ids: string[]) =>
        ids.map((id) => guild.roles.cache.get(id)?.name ?? id).slice(0, 10).join(', ');
      const embed = this.baseEmbed(0x5865f2, 'Member roles updated')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'User', value: newMember.user.tag, inline: true },
          { name: 'By', value: this.executorLine(entry?.executor?.tag), inline: true },
          ...(added.length ? [{ name: 'Added', value: fmt(added), inline: false }] : []),
          ...(removed.length ? [{ name: 'Removed', value: fmt(removed), inline: false }] : []),
        );
      await this.sendLog(guild, 'moderation', embed);

      // D4: a granted role carrying dangerous permissions.
      for (const roleId of added) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        const dangerous = ALERTS_CONFIG.d4.dangerousPermissions.filter((p) =>
          role.permissions.has(PermissionsBitField.Flags[p]),
        );
        if (dangerous.length) {
          this.alerts.onDangerousGrant(
            guild,
            `Role **${role.name}** (${dangerous.join(', ')}) granted to **${newMember.user.tag}**.`,
            entry?.executor?.id ?? null,
            entry?.executor?.tag ?? null,
          );
        }
      }
    }
  }

  // ═══════════════ Preset 3: MESSAGES ═══════════════

  @On('messageCreate')
  onMessageCreate(@Context() [message]: ContextOf<'messageCreate'>) {
    this.msgCache.remember(message);
  }

  @On('messageDelete')
  async onMessageDelete(@Context() [message]: ContextOf<'messageDelete'>) {
    if (!message.guild) return;
    const guild = message.guild;
    const cached = this.msgCache.get(message.channelId, message.id);
    const authorTag = cached?.authorTag ?? message.author?.tag ?? 'Unknown';
    const authorId = cached?.authorId ?? message.author?.id ?? null;
    const isBot = cached?.authorBot ?? message.author?.bot ?? false;
    if (isBot) return; // bot messages are not logged (TZ preset 3)

    const entry = await this.audit.lookup(guild, AuditLogEvent.MessageDelete, authorId);
    const deleterTag = entry?.executor?.tag ?? null;

    await this.logEvents.create({
      guildId: guild.id,
      type: 'messages',
      kind: 'message_delete',
      payload: {
        channelId: message.channel.id,
        channelName: 'name' in message.channel ? message.channel.name : undefined,
        authorTag,
        messageId: message.id,
        contentPreview: (cached?.content ?? message.content ?? '(unknown)').slice(0, 500),
      },
    });

    const content = (cached?.content ?? message.content ?? '').slice(0, 1000) || '(empty or not cached)';
    const files: AttachmentBuilder[] = [];
    for (const att of cached?.attachments ?? []) {
      // Re-attach cached files (TZ preset 3): proxy URL survives shortly
      // after deletion — best-effort.
      try {
        files.push(new AttachmentBuilder(att.proxyUrl, { name: att.name }));
      } catch {
        /* skip broken attachment */
      }
    }

    const embed = this.baseEmbed(0xed4245, 'Message deleted').addFields(
      { name: 'Channel', value: `${message.channel}`, inline: true },
      { name: 'Author', value: authorTag, inline: true },
      { name: 'Deleted by', value: this.executorLine(deleterTag), inline: true },
      { name: 'Content', value: content, inline: false },
    );
    await this.sendLog(guild, 'messages', embed, files.length ? files : undefined);

    // D8: author deleting their own messages en masse (no audit entry = самоудаление).
    if (!entry && authorId) this.alerts.onSelfMessageDelete(guild, authorId, authorTag);
  }

  @On('messageDeleteBulk')
  async onBulkDelete(@Context() [messages, channel]: ContextOf<'messageDeleteBulk'>) {
    const guild = channel.guild;
    if (!guild) return;
    const entry = await this.audit.lookup(guild, AuditLogEvent.MessageBulkDelete, null);
    const embed = this.baseEmbed(0xed4245, 'Bulk message deletion').addFields(
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Messages', value: String(messages.size), inline: true },
      { name: 'Deleted by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(guild, 'messages', embed);
  }

  @On('messageUpdate')
  async onMessageUpdate(@Context() [oldMsg, newMsg]: ContextOf<'messageUpdate'>) {
    if (!newMsg.guild || newMsg.author?.bot) return;
    const cached = this.msgCache.get(newMsg.channelId, newMsg.id);
    const before = (oldMsg.content ?? cached?.content ?? '').slice(0, 500) || '(empty or not cached)';
    const after = (newMsg.content ?? '').slice(0, 500) || '(empty)';
    if (before === after) return;
    if (newMsg instanceof Object && 'partial' in newMsg && !newMsg.partial) {
      this.msgCache.remember(newMsg as never);
    }

    await this.logEvents.create({
      guildId: newMsg.guild.id,
      type: 'messages',
      kind: 'message_edit',
      payload: {
        channelId: newMsg.channel.id,
        authorTag: newMsg.author?.tag ?? cached?.authorTag ?? 'Unknown',
        messageId: newMsg.id,
        oldContent: before,
        newContent: after,
        url: newMsg.url,
      },
    });
    const embed = this.baseEmbed(0xfee75c, 'Message edited')
      .setURL(newMsg.url)
      .addFields(
        { name: 'Channel', value: `${newMsg.channel}`, inline: true },
        { name: 'Author', value: newMsg.author?.tag ?? cached?.authorTag ?? 'Unknown', inline: true },
        { name: 'Before', value: before, inline: false },
        { name: 'After', value: after, inline: false },
      );
    await this.sendLog(newMsg.guild, 'messages', embed);
  }

  // ═══════════════ Preset 5: CHANNEL ═══════════════

  @On('channelCreate')
  async onChannelCreate(@Context() [ch]: ContextOf<'channelCreate'>) {
    if (!('guild' in ch) || !ch.guild) return;
    const entry = await this.audit.lookup(ch.guild, AuditLogEvent.ChannelCreate, ch.id);
    await this.logEvents.create({
      guildId: ch.guild.id,
      type: 'channel',
      kind: 'channel_create',
      payload: { channelId: ch.id, channelName: ch.name, channelType: ch.type },
    });
    const embed = this.baseEmbed(0x57f287, 'Channel created').addFields(
      { name: 'Channel', value: `${ch.name} (${ch})`, inline: true },
      { name: 'Created by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(ch.guild, 'channel', embed);
  }

  @On('channelDelete')
  async onChannelDelete(@Context() [ch]: ContextOf<'channelDelete'>) {
    if (!('guild' in ch) || !ch.guild) return;
    const guild = ch.guild;
    this.msgCache.forget(ch.id);
    const entry = await this.audit.lookup(guild, AuditLogEvent.ChannelDelete, ch.id);
    await this.logEvents.create({
      guildId: guild.id,
      type: 'channel',
      kind: 'channel_delete',
      payload: { channelId: ch.id, channelName: ch.name },
    });
    const embed = this.baseEmbed(0xed4245, 'Channel deleted').addFields(
      { name: 'Name', value: ch.name, inline: true },
      { name: 'Deleted by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(guild, 'channel', embed);

    this.alerts.onDestructiveAction(guild, 'channel_delete', entry?.executor?.id ?? null, entry?.executor?.tag ?? null);
  }

  @On('channelUpdate')
  async onChannelUpdate(@Context() [oldCh, newCh]: ContextOf<'channelUpdate'>) {
    if (!('guild' in newCh) || !newCh.guild) return;
    const guild = newCh.guild;
    const oldG = oldCh as GuildChannel;
    const newG = newCh as GuildChannel;

    const diffs: string[] = [];
    if (oldG.name !== newG.name) diffs.push(`Name: **${oldG.name}** → **${newG.name}**`);
    if ('topic' in oldG && 'topic' in newG && (oldG as TextChannel).topic !== (newG as TextChannel).topic) {
      diffs.push(
        `Topic: ${(oldG as TextChannel).topic?.slice(0, 100) ?? '(none)'} → ${(newG as TextChannel).topic?.slice(0, 100) ?? '(none)'}`,
      );
    }
    // Permission overwrite diff — compact: which targets changed.
    const oldPerms = new Map(oldG.permissionOverwrites?.cache.map((o) => [o.id, `${o.allow.bitfield}/${o.deny.bitfield}`]));
    const newPerms = new Map(newG.permissionOverwrites?.cache.map((o) => [o.id, `${o.allow.bitfield}/${o.deny.bitfield}`]));
    const changedTargets = new Set<string>();
    for (const [id, v] of newPerms) if (oldPerms.get(id) !== v) changedTargets.add(id);
    for (const id of oldPerms.keys()) if (!newPerms.has(id)) changedTargets.add(id);
    if (changedTargets.size) {
      const names = [...changedTargets]
        .map((id) => guild.roles.cache.get(id)?.name ?? guild.members.cache.get(id)?.user.tag ?? id)
        .slice(0, 8)
        .join(', ');
      diffs.push(`Permissions changed for: ${names}`);
    }
    if (!diffs.length) return;

    const entry = await this.audit.lookup(guild, AuditLogEvent.ChannelUpdate, newCh.id);
    const embed = this.baseEmbed(0xfee75c, 'Channel updated').addFields(
      { name: 'Channel', value: `${newG.name} (${newCh})`, inline: true },
      { name: 'Updated by', value: this.executorLine(entry?.executor?.tag), inline: true },
      { name: 'Changes', value: diffs.join('\n').slice(0, 1000), inline: false },
    );
    await this.sendLog(guild, 'channel', embed);
  }

  // ═══════════════ Preset 6: SERVER (roles/emojis/webhooks/guild) ═══════════════

  @On('roleCreate')
  async onRoleCreate(@Context() [role]: ContextOf<'roleCreate'>) {
    const entry = await this.audit.lookup(role.guild, AuditLogEvent.RoleCreate, role.id);
    const embed = this.baseEmbed(0x57f287, 'Role created').addFields(
      { name: 'Role', value: role.name, inline: true },
      { name: 'Created by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(role.guild, 'server', embed);
  }

  @On('roleDelete')
  async onRoleDelete(@Context() [role]: ContextOf<'roleDelete'>) {
    const entry = await this.audit.lookup(role.guild, AuditLogEvent.RoleDelete, role.id);
    const embed = this.baseEmbed(0xed4245, 'Role deleted').addFields(
      { name: 'Role', value: role.name, inline: true },
      { name: 'Deleted by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(role.guild, 'server', embed);

    this.alerts.onDestructiveAction(role.guild, 'role_delete', entry?.executor?.id ?? null, entry?.executor?.tag ?? null);
  }

  @On('roleUpdate')
  async onRoleUpdate(@Context() [oldRole, newRole]: ContextOf<'roleUpdate'>) {
    const guild = newRole.guild;
    const diffs: string[] = [];
    if (oldRole.name !== newRole.name) diffs.push(`Name: **${oldRole.name}** → **${newRole.name}**`);
    if (oldRole.color !== newRole.color) diffs.push('Color changed');

    const addedPerms = newRole.permissions.toArray().filter((p) => !oldRole.permissions.has(p));
    const removedPerms = oldRole.permissions.toArray().filter((p) => !newRole.permissions.has(p));
    if (addedPerms.length) diffs.push(`Permissions added: **${addedPerms.join(', ')}**`);
    if (removedPerms.length) diffs.push(`Permissions removed: ${removedPerms.join(', ')}`);
    if (!diffs.length) return;

    const entry = await this.audit.lookup(guild, AuditLogEvent.RoleUpdate, newRole.id);
    const embed = this.baseEmbed(0xfee75c, 'Role updated').addFields(
      { name: 'Role', value: newRole.name, inline: true },
      { name: 'Updated by', value: this.executorLine(entry?.executor?.tag), inline: true },
      { name: 'Changes', value: diffs.join('\n').slice(0, 1000), inline: false },
    );
    await this.sendLog(guild, 'server', embed);

    // D4: dangerous permission ADDED to a role (diff-based, TZ §5).
    const dangerousAdded = ALERTS_CONFIG.d4.dangerousPermissions.filter((p) => (addedPerms as string[]).includes(p));
    if (dangerousAdded.length) {
      this.alerts.onDangerousGrant(
        guild,
        `Role **${newRole.name}** got new permissions: **${dangerousAdded.join(', ')}**.`,
        entry?.executor?.id ?? null,
        entry?.executor?.tag ?? null,
      );
    }
  }

  @On('emojiCreate')
  async onEmojiCreate(@Context() [emoji]: ContextOf<'emojiCreate'>) {
    const embed = this.baseEmbed(0x57f287, 'Emoji created').addFields({
      name: 'Emoji',
      value: `${emoji} \`:${emoji.name}:\``,
      inline: true,
    });
    await this.sendLog(emoji.guild, 'server', embed);
  }

  @On('emojiDelete')
  async onEmojiDelete(@Context() [emoji]: ContextOf<'emojiDelete'>) {
    const embed = this.baseEmbed(0xed4245, 'Emoji deleted').addFields({
      name: 'Emoji',
      value: `\`:${emoji.name}:\``,
      inline: true,
    });
    await this.sendLog(emoji.guild, 'server', embed);
  }

  @On('emojiUpdate')
  async onEmojiUpdate(@Context() [oldEmoji, newEmoji]: ContextOf<'emojiUpdate'>) {
    if (oldEmoji.name === newEmoji.name) return;
    const embed = this.baseEmbed(0xfee75c, 'Emoji renamed').addFields({
      name: 'Emoji',
      value: `\`:${oldEmoji.name}:\` → \`:${newEmoji.name}:\``,
      inline: true,
    });
    await this.sendLog(newEmoji.guild, 'server', embed);
  }

  @On('webhooksUpdate')
  async onWebhooksUpdate(@Context() [channel]: ContextOf<'webhooksUpdate'>) {
    const guild = channel.guild;
    try {
      const hooks = await channel.fetchWebhooks();
      let seen = this.seenWebhooks.get(guild.id);
      const firstScan = !seen;
      if (!seen) {
        seen = new Set();
        this.seenWebhooks.set(guild.id, seen);
        // Seed with our own personalization webhooks (TZ §5 D6).
        const ours = await this.webhookCacheRepo.find({ where: { guildId: guild.id } });
        for (const h of ours) seen.add(h.webhookId);
      }
      for (const hook of hooks.values()) {
        const isNew = !seen.has(hook.id);
        seen.add(hook.id);
        if (firstScan || !isNew) continue;
        const ownedByUs = hook.owner?.id === this.client.user?.id;

        const entry = await this.audit.lookup(guild, AuditLogEvent.WebhookCreate, null);
        const embed = this.baseEmbed(0xfee75c, 'Webhook created').addFields(
          { name: 'Webhook', value: hook.name ?? hook.id, inline: true },
          { name: 'Channel', value: `${channel}`, inline: true },
          { name: 'Created by', value: this.executorLine(entry?.executor?.tag ?? (hook.owner && 'tag' in hook.owner ? hook.owner.tag : null)), inline: true },
        );
        await this.sendLog(guild, 'server', embed);

        if (!ownedByUs) {
          this.alerts.onForeignWebhook(
            guild,
            channel.name,
            hook.name ?? hook.id,
            entry?.executor?.id ?? null,
            entry?.executor?.tag ?? (hook.owner && 'tag' in hook.owner ? hook.owner.tag : null),
          );
        }
      }
    } catch (e) {
      this.logger.debug(`webhooksUpdate handling failed: ${(e as Error).message}`);
    }
  }

  @On('guildUpdate')
  async onGuildUpdate(@Context() [oldGuild, newGuild]: ContextOf<'guildUpdate'>) {
    const changes: string[] = [];
    if (oldGuild.name !== newGuild.name) changes.push(`Name: **${oldGuild.name}** → **${newGuild.name}**`);
    if (oldGuild.icon !== newGuild.icon) changes.push('Server icon changed');
    if (oldGuild.vanityURLCode !== newGuild.vanityURLCode) {
      changes.push(`Vanity URL: ${oldGuild.vanityURLCode ?? '(none)'} → ${newGuild.vanityURLCode ?? '(none)'}`);
    }
    const verificationLowered = newGuild.verificationLevel < oldGuild.verificationLevel;
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
      changes.push(
        `Verification level: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}${verificationLowered ? ' (lowered)' : ''}`,
      );
    }
    if (!changes.length) return;

    const entry = await this.audit.lookup(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
    const embed = this.baseEmbed(0xfee75c, 'Server settings updated').addFields(
      { name: 'Changes', value: changes.join('\n').slice(0, 1000), inline: false },
      { name: 'Updated by', value: this.executorLine(entry?.executor?.tag), inline: true },
    );
    await this.sendLog(newGuild, 'server', embed);

    // D9 fires only on name / vanity / verification-lowered (TZ §5).
    const critical = changes.filter((c) => !c.startsWith('Server icon'));
    this.alerts.onGuildSettingsChange(
      newGuild,
      critical,
      verificationLowered,
      entry?.executor?.id ?? null,
      entry?.executor?.tag ?? null,
    );
  }

  // ═══════════════ Preset 7: VOICE ═══════════════

  @On('voiceStateUpdate')
  async onVoiceState(@Context() [oldState, newState]: ContextOf<'voiceStateUpdate'>) {
    const guild = newState.guild;
    const user = newState.member?.user ?? oldState.member?.user;
    if (!user || user.bot) return;

    let embed: EmbedBuilder | null = null;
    if (!oldState.channelId && newState.channelId) {
      embed = this.baseEmbed(0x57f287, 'Voice join').addFields(
        { name: 'User', value: user.tag, inline: true },
        { name: 'Channel', value: `${newState.channel?.name ?? newState.channelId}`, inline: true },
      );
    } else if (oldState.channelId && !newState.channelId) {
      embed = this.baseEmbed(0xed4245, 'Voice leave').addFields(
        { name: 'User', value: user.tag, inline: true },
        { name: 'Channel', value: `${oldState.channel?.name ?? oldState.channelId}`, inline: true },
      );
    } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      embed = this.baseEmbed(0xfee75c, 'Voice move').addFields(
        { name: 'User', value: user.tag, inline: true },
        {
          name: 'Move',
          value: `${oldState.channel?.name ?? oldState.channelId} → ${newState.channel?.name ?? newState.channelId}`,
          inline: true,
        },
      );
    } else if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
      const bits: string[] = [];
      if (oldState.serverMute !== newState.serverMute) bits.push(newState.serverMute ? 'Server muted' : 'Server unmuted');
      if (oldState.serverDeaf !== newState.serverDeaf) bits.push(newState.serverDeaf ? 'Server deafened' : 'Server undeafened');
      embed = this.baseEmbed(0x5865f2, 'Voice state changed').addFields(
        { name: 'User', value: user.tag, inline: true },
        { name: 'Change', value: bits.join(', '), inline: true },
        { name: 'Channel', value: `${newState.channel?.name ?? oldState.channel?.name ?? '—'}`, inline: true },
      );
    }
    if (embed) await this.sendLog(guild, 'voice', embed);
  }
}
