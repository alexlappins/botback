import { Injectable } from '@nestjs/common';
import { Context, Options, SlashCommand } from 'necord';
import type { SlashCommandContext } from 'necord';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { GuildStorageService } from '../common/storage/guild-storage.service';
import { SetupEmojiRoleDto } from './dto/setup-emoji-role.dto';
import { SetupRoleDto } from './dto/setup-role.dto';

/** Префикс customId для кнопок "роль по нажатию". После слэша — ID роли. */
export const REACTION_ROLE_PREFIX = 'rr';

/** Нормализация эмодзи в ключ хранилища: кастомный id или unicode как есть. */
function emojiToKey(emoji: string): string {
  const trimmed = emoji.trim();
  // <:name:123> или name:123 → id
  const customMatch = trimmed.match(/:(\d+)>?$/);
  if (customMatch) return customMatch[1];
  if (trimmed.includes(':')) {
    const part = trimmed.split(':').pop();
    if (part && /^\d+$/.test(part)) return part;
  }
  return trimmed;
}

@Injectable()
export class ReactionRolesCommands {
  constructor(private readonly storage: GuildStorageService) {}

  @SlashCommand({
    name: 'reaction-role',
    description: 'Создать сообщение с кнопкой: нажатие выдаёт или снимает роль',
  })
  async onSetup(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: SetupRoleDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.guild?.channels.cache.get(dto.channel.id);
    if (!channel?.isTextBased()) {
      return interaction.editReply({ content: 'Укажите текстовый канал.' });
    }

    const role = interaction.guild?.roles.cache.get(dto.role.id);
    if (!role) {
      return interaction.editReply({ content: 'Роль не найдена.' });
    }

    const customId = `${REACTION_ROLE_PREFIX}/${dto.role.id}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(dto.role.name)
        .setStyle(ButtonStyle.Primary),
    );

    const content = dto.text ?? `Нажми кнопку, чтобы получить или снять роль **${dto.role.name}**.`;
    const embed = new EmbedBuilder()
      .setDescription(content)
      .setColor(0x57f287);

    await (channel as import('discord.js').TextChannel).send({
      embeds: [embed],
      components: [row],
    });

    return interaction.editReply({
      content: `Сообщение с кнопкой для роли **${dto.role.name}** отправлено в <#${dto.channel.id}>.`,
    });
  }

  @SlashCommand({
    name: 'reaction-role-emoji',
    description: 'Привязать эмодзи на сообщении к роли: реакция выдаёт или снимает роль',
  })
  async onSetupEmoji(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: SetupEmojiRoleDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Команда только для сервера.' });
    }

    const channel = interaction.guild?.channels.cache.get(dto.channel.id);
    if (!channel?.isTextBased()) {
      return interaction.editReply({ content: 'Укажите текстовый канал.' });
    }

    const role = interaction.guild?.roles.cache.get(dto.role.id);
    if (!role) {
      return interaction.editReply({ content: 'Роль не найдена.' });
    }

    let message: import('discord.js').Message;
    try {
      message = await (channel as import('discord.js').TextChannel).messages.fetch(dto.messageId);
    } catch {
      return interaction.editReply({
        content: 'Сообщение не найдено. Проверьте канал и ID сообщения (из ссылки).',
      });
    }

    const emojiKey = emojiToKey(dto.emoji);
    try {
      await message.react(dto.emoji.trim());
    } catch (e) {
      const err = e as Error;
      return interaction.editReply({
        content: `Не удалось поставить реакцию: ${err.message}. Проверьте формат эмодзи (для кастомного используйте имя:id).`,
      });
    }

    this.storage.setReactionRoleBinding(guildId, message.id, emojiKey, dto.role.id);
    this.storage.setReactionRoleChannel(guildId, message.id, message.channelId);

    return interaction.editReply({
      content: `Реакция привязана к роли **${dto.role.name}**. Кто поставит этот эмодзи — получит роль, кто уберёт — лишится.`,
    });
  }
}
