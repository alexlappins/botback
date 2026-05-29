import { Injectable } from '@nestjs/common';
import {
  ChannelOption,
  Context,
  createCommandGroupDecorator,
  Options,
  StringOption,
  Subcommand,
} from 'necord';
import type { SlashCommandContext } from 'necord';
import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type GuildBasedChannel,
} from 'discord.js';

import { TwitchAdminService } from './twitch-admin.service';

class AddDto {
  @StringOption({
    name: 'username',
    description: 'Twitch username (without the @)',
    required: true,
  })
  username: string;

  @ChannelOption({
    name: 'channel',
    description: 'Discord channel for live notifications',
    required: true,
    channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  })
  channel: GuildBasedChannel;
}

class RemoveDto {
  @StringOption({
    name: 'username',
    description: 'Twitch username to stop tracking',
    required: true,
  })
  username: string;
}

const TwitchGroup = createCommandGroupDecorator({
  name: 'twitch',
  description: 'Twitch live notifications',
  defaultMemberPermissions: PermissionFlagsBits.ManageGuild,
});

@TwitchGroup()
@Injectable()
export class TwitchCommands {
  constructor(private readonly admin: TwitchAdminService) {}

  @Subcommand({ name: 'add', description: 'Start tracking a Twitch channel' })
  async onAdd(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: AddDto,
  ) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const result = await this.admin
      .addByUsername(interaction.guildId, dto.username, dto.channel.id)
      .catch((e: Error) => ({ ok: false as const, reason: 'crash' as const, message: e.message }));

    if (!result.ok) {
      return interaction.editReply({ content: `❌ ${result.message}` });
    }
    return interaction.editReply({
      content: `✅ Tracking **${result.subscription.platformUsername}** — notifications will appear in <#${dto.channel.id}>.`,
    });
  }

  @Subcommand({ name: 'remove', description: 'Stop tracking a Twitch channel' })
  async onRemove(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: RemoveDto,
  ) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const removed = await this.admin.removeByUsername(interaction.guildId, dto.username);
    return interaction.editReply({
      content: removed
        ? `🗑 Stopped tracking **${dto.username}**.`
        : `Couldn't find **${dto.username}** in this server's tracked list.`,
    });
  }

  @Subcommand({ name: 'list', description: 'List tracked Twitch channels' })
  async onList(@Context() [interaction]: SlashCommandContext) {
    if (!interaction.guildId) {
      return interaction.reply({ content: 'Server only.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const items = await this.admin.listForGuild(interaction.guildId);
    const limit = this.admin.getLimit(interaction.guildId);

    if (items.length === 0) {
      return interaction.editReply({
        content: `No Twitch channels are being tracked. Add one with \`/twitch add\`. Limit: ${limit}.`,
      });
    }

    const lines = items.map((s) => {
      const status = s.isLive ? '🔴 LIVE' : '⚫ offline';
      return `• **${s.platformUsername}** — ${status}  →  <#${s.discordChannelId}>`;
    });
    const embed = new EmbedBuilder()
      .setTitle('🎮 Tracked Twitch channels')
      .setColor('#9146FF')
      .setDescription(lines.join('\n'))
      .setFooter({ text: `${items.length} / ${limit} slots used` });
    return interaction.editReply({ embeds: [embed] });
  }
}
