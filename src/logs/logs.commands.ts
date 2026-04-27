import { Injectable } from '@nestjs/common';
import {
  Context,
  createCommandGroupDecorator,
  Options,
  Subcommand,
} from 'necord';
import type { SlashCommandContext } from 'necord';
import {
  GuildStorageService,
  type LogChannelsConfig,
} from '../common/storage/guild-storage.service';
import { ChannelOption, StringOption } from 'necord';

const LOG_TYPE_CHOICES = [
  { name: 'Join / Leave (join-leave)', value: 'joinLeave' },
  { name: 'Messages (messages)', value: 'messages' },
  { name: 'Moderation (moderation)', value: 'moderation' },
  { name: 'Channels (channel)', value: 'channel' },
  { name: 'Ban / Kick (ban-kick)', value: 'banKick' },
] as const;

const LOG_NAMES: Record<string, string> = {
  joinLeave: 'Join / Leave',
  messages: 'Messages',
  moderation: 'Moderation',
  channel: 'Channels',
  banKick: 'Ban / Kick',
};

class LogsSetDto {
  @StringOption({
    name: 'type',
    description: 'Log type',
    required: true,
    choices: [...LOG_TYPE_CHOICES],
  })
  type: string;

  @ChannelOption({
    name: 'channel',
    description: 'Channel for logs',
    required: true,
  })
  channel: { id: string };
}

class LogsOffDto {
  @StringOption({
    name: 'type',
    description: 'Log type',
    required: true,
    choices: [...LOG_TYPE_CHOICES],
  })
  type: string;
}

const LogsGroup = createCommandGroupDecorator({
  name: 'logs',
  description: 'Configure log channels for server events',
});

@LogsGroup()
@Injectable()
export class LogsCommands {
  constructor(private readonly storage: GuildStorageService) {}

  @Subcommand({
    name: 'set',
    description: 'Set the channel for a log type',
  })
  async onSet(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsSetDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Server only.' });
    }

    const key = dto.type as keyof LogChannelsConfig;
    this.storage.setLogChannel(guildId, key, dto.channel.id);

    return interaction.editReply({
      content: `**${LOG_NAMES[key] ?? key}** logs will be sent to <#${dto.channel.id}>.`,
    });
  }

  @Subcommand({
    name: 'off',
    description: 'Disable logs of a specific type',
  })
  async onOff(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsOffDto,
  ) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Server only.' });
    }
    const key = dto.type as keyof LogChannelsConfig;
    this.storage.setLogChannel(guildId, key, null);
    return interaction.editReply({
      content: `**${LOG_NAMES[key] ?? key}** logs disabled.`,
    });
  }
}
