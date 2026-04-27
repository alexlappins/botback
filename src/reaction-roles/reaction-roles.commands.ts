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
    description: 'Create a message with a button: clicking grants or removes a role',
  })
  async onSetup(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: SetupRoleDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const channel = interaction.guild?.channels.cache.get(dto.channel.id);
    if (!channel?.isTextBased()) {
      return interaction.editReply({ content: 'Please specify a text channel.' });
    }

    const role = interaction.guild?.roles.cache.get(dto.role.id);
    if (!role) {
      return interaction.editReply({ content: 'Role not found.' });
    }

    const customId = `${REACTION_ROLE_PREFIX}/${dto.role.id}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(dto.role.name)
        .setStyle(ButtonStyle.Primary),
    );

    const content = dto.text ?? `Click the button to receive or remove the **${dto.role.name}** role.`;
    const embed = new EmbedBuilder()
      .setDescription(content)
      .setColor(0x57f287);

    await (channel as import('discord.js').TextChannel).send({
      embeds: [embed],
      components: [row],
    });

    return interaction.editReply({
      content: `Button message for role **${dto.role.name}** sent to <#${dto.channel.id}>.`,
    });
  }

  @SlashCommand({
    name: 'reaction-role-emoji',
    description: 'Bind an emoji on a message to a role: reacting grants or removes the role',
  })
  async onSetupEmoji(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: SetupEmojiRoleDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Server only.' });
    }

    const channel = interaction.guild?.channels.cache.get(dto.channel.id);
    if (!channel?.isTextBased()) {
      return interaction.editReply({ content: 'Please specify a text channel.' });
    }

    const role = interaction.guild?.roles.cache.get(dto.role.id);
    if (!role) {
      return interaction.editReply({ content: 'Role not found.' });
    }

    let message: import('discord.js').Message;
    try {
      message = await (channel as import('discord.js').TextChannel).messages.fetch(dto.messageId);
    } catch {
      return interaction.editReply({
        content: 'Message not found. Check the channel and the message ID (from the link).',
      });
    }

    const emojiKey = emojiToKey(dto.emoji);
    try {
      await message.react(dto.emoji.trim());
    } catch (e) {
      const err = e as Error;
      return interaction.editReply({
        content: `Failed to add reaction: ${err.message}. Check the emoji format (for a custom emoji use name:id).`,
      });
    }

    this.storage.setReactionRoleBinding(guildId, message.id, emojiKey, dto.role.id);
    this.storage.setReactionRoleChannel(guildId, message.id, message.channelId);

    return interaction.editReply({
      content: `Reaction bound to role **${dto.role.name}**. Adding this emoji grants the role, removing it takes the role away.`,
    });
  }
}
