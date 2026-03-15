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
      .setTitle('Участник присоединился')
      .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
      .addFields(
        { name: 'Пользователь', value: `${member.user.tag}`, inline: true },
        { name: 'ID', value: member.user.id, inline: true },
        {
          name: 'Дата',
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

    // Пытаемся определить кик через Audit Log
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
            const reason = kickEntry.reason?.slice(0, 500) ?? 'Не указана';
            const embed = new EmbedBuilder()
              .setColor(0xe67e22)
              .setTitle('Участник кикнут')
              .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
              .addFields(
                { name: 'Пользователь', value: member.user?.tag ?? 'Unknown', inline: true },
                { name: 'ID', value: member.id, inline: true },
                {
                  name: 'Кикнул',
                  value: kickEntry.executor?.tag ?? 'Unknown',
                  inline: true,
                },
                { name: 'Причина', value: reason, inline: false },
                {
                  name: 'Дата',
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
                reason: kickEntry.reason ?? 'Не указана',
              },
            });
            return;
          }
        }
      }
    } catch {
      // нет прав на audit log или ошибка — логируем как обычный выход
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
      .setTitle('Участник покинул сервер')
      .setThumbnail(member.user?.displayAvatarURL?.({ size: 128 }) ?? null)
      .addFields(
        { name: 'Пользователь', value: member.user?.tag ?? 'Unknown', inline: true },
        { name: 'ID', value: member.id, inline: true },
        {
          name: 'Дата',
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
        .setTitle('Таймаут применён')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Пользователь', value: userTag, inline: true },
          { name: 'ID', value: userId, inline: true },
          {
            name: 'До',
            value: `<t:${Math.floor(newUntil.getTime() / 1000)}:F>`,
            inline: true,
          },
          {
            name: 'Дата',
            value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
            inline: false,
          },
        );
      await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('Таймаут снят')
        .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
        .addFields(
          { name: 'Пользователь', value: userTag, inline: true },
          { name: 'ID', value: userId, inline: true },
          {
            name: 'Дата',
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

    const contentPreview = message.content?.slice(0, 500) ?? '(пусто)';
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

    const content = message.content?.slice(0, 1000) || '(пусто)';
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Сообщение удалено')
      .addFields(
        { name: 'Канал', value: `${message.channel}`, inline: true },
        { name: 'Автор', value: message.author?.tag ?? 'Unknown', inline: true },
        { name: 'ID сообщения', value: message.id, inline: true },
        { name: 'Содержимое', value: content, inline: false },
        {
          name: 'Дата',
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

    const oldContent = oldMsg.content?.slice(0, 500) || '(пусто)';
    const newContent = newMsg.content?.slice(0, 500) || '(пусто)';
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
      .setTitle('Сообщение отредактировано')
      .setURL(newMsg.url)
      .addFields(
        { name: 'Канал', value: `${newMsg.channel}`, inline: true },
        { name: 'Автор', value: newMsg.author?.tag ?? 'Unknown', inline: true },
        { name: 'Было', value: oldContent, inline: false },
        { name: 'Стало', value: newContent, inline: false },
        {
          name: 'Дата',
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
      .setTitle('Канал создан')
      .addFields(
        { name: 'Канал', value: `${channelName} (${ch})`, inline: true },
        { name: 'Тип', value: String(ch.type), inline: true },
        {
          name: 'Дата',
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
      .setTitle('Канал удалён')
      .addFields(
        { name: 'Имя', value: channelName, inline: true },
        { name: 'ID', value: ch.id, inline: true },
        {
          name: 'Дата',
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
        reason: ban.reason ?? 'Не указана',
      },
    });

    const channelId = this.storage.getLogChannel(guildId, 'banKick');
    if (!channelId) return;

    const channel = ban.guild.channels.cache.get(channelId);
    if (!channel?.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('Пользователь забанен')
      .setThumbnail(ban.user?.displayAvatarURL({ size: 128 }) ?? null)
      .addFields(
        { name: 'Пользователь', value: ban.user?.tag ?? 'Unknown', inline: true },
        { name: 'ID', value: ban.user?.id ?? ban.guild.id, inline: true },
        {
          name: 'Причина',
          value: ban.reason?.slice(0, 500) || 'Не указана',
          inline: false,
        },
        {
          name: 'Дата',
          value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
          inline: false,
        },
      );

    await (channel as import('discord.js').TextChannel).send({ embeds: [embed] });
  }
}
