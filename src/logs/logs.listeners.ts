import { Injectable } from '@nestjs/common';
import { Context, On } from 'necord';
import type { ContextOf } from 'necord';
import { AuditLogEvent, EmbedBuilder } from 'discord.js';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { LogEventsService } from './log-events.service';

@Injectable()
export class LogsListeners {
  constructor(
    private readonly storage: GuildStorageService,
    private readonly logEvents: LogEventsService,
  ) {}

  @On('guildMemberAdd')
  async onMemberJoin(@Context() [member]: ContextOf<'guildMemberAdd'>) {
    const guildId = member.guild.id;

    await this.logEvents.create({
      guildId,
      type: 'joinLeave',
      kind: 'member_join',
      payload: {
        userId: member.user.id,
        userTag: member.user.tag,
        avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      },
    });

    const channelId = this.storage.getLogChannel(guildId, 'joinLeave');
    if (!channelId) return;

    const channel = member.guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Member joined')
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'User', value: `${member.user.tag}`, inline: true },
        { name: 'ID', value: member.user.id, inline: true },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('guildMemberRemove')
  async onMemberLeave(@Context() [member]: ContextOf<'guildMemberRemove'>) {
    const guild = member.guild;
    const guildId = guild.id;

    // Try to detect a kick via Audit Log
    try {
      const logs = await guild.fetchAuditLogs({
        type: AuditLogEvent.MemberKick,
        limit: 5,
      });
      const kickEntry = logs.entries.find(
        (e) =>
          e.targetId === member.id &&
          Date.now() - e.createdTimestamp < 10_000,
      );
      if (kickEntry) {
        const channelId = this.storage.getLogChannel(guildId, 'banKick');
        if (channelId) {
          const channel = guild.channels.cache.get(channelId);
          if (channel?.isTextBased()) {
            const reason = kickEntry.reason?.slice(0, 500) ?? 'Not specified';
            const embed = new EmbedBuilder()
              .setColor(0xe67e22)
              .setTitle('Member kicked')
              .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
              .addFields(
                { name: 'User', value: member.user?.tag ?? 'Unknown', inline: true },
                { name: 'ID', value: member.id, inline: true },
                {
                  name: 'Kicked by',
                  value: kickEntry.executor?.tag ?? 'Unknown',
                  inline: true,
                },
                { name: 'Reason', value: reason, inline: false },
                {
                  name: 'Date',
                  value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                  inline: false,
                },
              );
            await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
            await this.logEvents.create({
              guildId,
              type: 'banKick',
              kind: 'member_kick',
              payload: {
                userId: member.id,
                userTag: member.user?.tag ?? 'Unknown',
                executorTag: kickEntry.executor?.tag ?? 'Unknown',
                reason: kickEntry.reason ?? 'Not specified',
              },
            });
            return;
          }
        }
      }
    } catch {
      // no audit log permission or error — log as a regular leave
    }

    await this.logEvents.create({
      guildId,
      type: 'joinLeave',
      kind: 'member_leave',
      payload: {
        userId: member.id,
        userTag: member.user?.tag ?? 'Unknown',
        avatarUrl: member.user?.displayAvatarURL?.({ size: 128 }) ?? undefined,
      },
    });

    const channelId = this.storage.getLogChannel(guildId, 'joinLeave');
    if (!channelId) return;

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Member left the server')
      .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
      .addFields(
        { name: 'User', value: member.user?.tag ?? 'Unknown', inline: true },
        { name: 'ID', value: member.id, inline: true },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('guildMemberUpdate')
  async onMemberUpdate(
    @Context() [oldMember, newMember]: ContextOf<'guildMemberUpdate'>,
  ) {
    const guildId = newMember.guild.id;
    const oldUntil = oldMember.communicationDisabledUntil;
    const newUntil = newMember.communicationDisabledUntil;

    if (oldUntil?.getTime() === newUntil?.getTime()) return;

    const userTag = newMember.user.tag;
    const userId = newMember.user.id;

    if (newUntil) {
      await this.logEvents.create({
        guildId,
        type: 'moderation',
        kind: 'timeout',
        payload: {
          userId,
          userTag,
          untilTimestamp: Math.floor(newUntil.getTime() / 1000),
        },
      });
    } else {
      await this.logEvents.create({
        guildId,
        type: 'moderation',
        kind: 'timeout_remove',
        payload: { userId, userTag },
      });
    }

    const channelId = this.storage.getLogChannel(guildId, 'moderation');
    if (!channelId) return;

    const channel = newMember.guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    if (newUntil) {
      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle('Timeout applied')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'User', value: userTag, inline: true },
          { name: 'ID', value: userId, inline: true },
          {
            name: 'Until',
            value: `<t:${Math.floor(newUntil.getTime() / 1000)}:F>`,
            inline: true,
          },
          {
            name: 'Date',
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
            inline: false,
          },
        );
      await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('Timeout removed')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'User', value: userTag, inline: true },
          { name: 'ID', value: userId, inline: true },
          {
            name: 'Date',
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
            inline: false,
          },
        );
      await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
    }
  }

  @On('messageDelete')
  async onMessageDelete(@Context() [message]: ContextOf<'messageDelete'>) {
    if (!message.guild) return;
    const guildId = message.guild.id;

    const contentPreview = message.content?.slice(0, 500) ?? '(empty)';
    await this.logEvents.create({
      guildId,
      type: 'messages',
      kind: 'message_delete',
      payload: {
        channelId: message.channel.id,
        channelName: 'name' in message.channel ? message.channel.name : undefined,
        authorTag: message.author?.tag ?? 'Unknown',
        messageId: message.id,
        contentPreview,
      },
    });

    const channelId = this.storage.getLogChannel(guildId, 'messages');
    if (!channelId) return;

    const logChannel = message.guild.channels.cache.get(channelId);
    if (!logChannel?.isTextBased()) return;

    const content = message.content?.slice(0, 1000) || '(empty)';
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Message deleted')
      .addFields(
        { name: 'Channel', value: `${message.channel}`, inline: true },
        { name: 'Author', value: message.author?.tag ?? 'Unknown', inline: true },
        { name: 'Message ID', value: message.id, inline: true },
        { name: 'Content', value: content, inline: false },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (logChannel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('messageUpdate')
  async onMessageUpdate(@Context() [oldMsg, newMsg]: ContextOf<'messageUpdate'>) {
    if (!newMsg.guild || newMsg.author?.bot) return;
    if (oldMsg.content === newMsg.content) return;

    const oldContent = oldMsg.content?.slice(0, 500) || '(empty)';
    const newContent = newMsg.content?.slice(0, 500) || '(empty)';
    await this.logEvents.create({
      guildId: newMsg.guild.id,
      type: 'messages',
      kind: 'message_edit',
      payload: {
        channelId: newMsg.channel.id,
        authorTag: newMsg.author?.tag ?? 'Unknown',
        messageId: newMsg.id,
        oldContent,
        newContent,
        url: newMsg.url,
      },
    });

    const channelId = this.storage.getLogChannel(newMsg.guild.id, 'messages');
    if (!channelId) return;

    const logChannel = newMsg.guild.channels.cache.get(channelId);
    if (!logChannel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0xfee75c)
      .setTitle('Message edited')
      .setURL(newMsg.url)
      .addFields(
        { name: 'Channel', value: `${newMsg.channel}`, inline: true },
        { name: 'Author', value: newMsg.author?.tag ?? 'Unknown', inline: true },
        { name: 'Before', value: oldContent, inline: false },
        { name: 'After', value: newContent, inline: false },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (logChannel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('channelCreate')
  async onChannelCreate(@Context() [ch]: ContextOf<'channelCreate'>) {
    if (!('guild' in ch) || !ch.guild) return;
    const guild = ch.guild;
    const channelName = 'name' in ch ? ch.name : String(ch);
    await this.logEvents.create({
      guildId: guild.id,
      type: 'channel',
      kind: 'channel_create',
      payload: { channelId: ch.id, channelName, channelType: ch.type },
    });

    const channelId = this.storage.getLogChannel(guild.id, 'channel');
    if (!channelId) return;

    const logChannel = guild.channels.cache.get(channelId);
    if (!logChannel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('Channel created')
      .addFields(
        { name: 'Channel', value: `${channelName} (${ch})`, inline: true },
        { name: 'Type', value: String(ch.type), inline: true },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (logChannel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('channelDelete')
  async onChannelDelete(@Context() [ch]: ContextOf<'channelDelete'>) {
    if (!('guild' in ch) || !ch.guild) return;
    const guild = ch.guild;
    const channelName = ('name' in ch ? ch.name : (ch as { id: string }).id) ?? '';
    await this.logEvents.create({
      guildId: guild.id,
      type: 'channel',
      kind: 'channel_delete',
      payload: { channelId: ch.id, channelName },
    });

    const channelId = this.storage.getLogChannel(guild.id, 'channel');
    if (!channelId) return;

    const logChannel = guild.channels.cache.get(channelId);
    if (!logChannel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Channel deleted')
      .addFields(
        { name: 'Name', value: channelName, inline: true },
        { name: 'ID', value: ch.id, inline: true },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (logChannel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }

  @On('guildBanAdd')
  async onGuildBanAdd(@Context() [ban]: ContextOf<'guildBanAdd'>) {
    const guildId = ban.guild.id;

    await this.logEvents.create({
      guildId,
      type: 'banKick',
      kind: 'ban_add',
      payload: {
        userId: ban.user?.id,
        userTag: ban.user?.tag ?? 'Unknown',
        reason: ban.reason ?? 'Not specified',
      },
    });

    const channelId = this.storage.getLogChannel(guildId, 'banKick');
    if (!channelId) return;

    const channel = ban.guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('User banned')
      .setThumbnail(ban.user?.displayAvatarURL({ size: 128 }) ?? null)
      .addFields(
        { name: 'User', value: ban.user?.tag ?? 'Unknown', inline: true },
        { name: 'ID', value: ban.user?.id ?? ban.guild.id, inline: true },
        {
          name: 'Reason',
          value: ban.reason?.slice(0, 500) || 'Not specified',
          inline: false,
        },
        {
          name: 'Date',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }
}
