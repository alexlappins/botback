import { Injectable } from '@nestjs/common';
import {
  Context,
  createCommandGroupDecorator,
  Options,
  Subcommand,
} from 'necord';
import type { SlashCommandContext } from 'necord';
import { ChannelOption, StringOption } from 'necord';
import { LogSettingsService } from './log-settings.service';
import type { LogPreset } from './log-presets';

/** Slash command mirror of the dashboard presets (Server Logs 2.0). */
const LOG_TYPE_CHOICES = [
  { name: 'Ban / Unban', value: 'ban' },
  { name: 'Join / Leave', value: 'joinLeave' },
  { name: 'Messages', value: 'messages' },
  { name: 'Moderation', value: 'moderation' },
  { name: 'Channels', value: 'channel' },
  { name: 'Server', value: 'server' },
  { name: 'Voice', value: 'voice' },
] as const;

const LOG_NAMES: Record<string, string> = Object.fromEntries(
  LOG_TYPE_CHOICES.map((c) => [c.value, c.name]),
);

class LogsSetDto {
  @StringOption({
    name: 'type',
    description: 'Log group',
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
    description: 'Log group',
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
  constructor(private readonly settings: LogSettingsService) {}

  @Subcommand({
    name: 'set',
    description: 'Set the channel for a log group',
  })
  async onSet(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsSetDto,
  ) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) return interaction.editReply({ content: 'Server only.' });

    const preset = dto.type as LogPreset;
    await this.settings.update(guildId, {
      presets: { [preset]: { enabled: true, channelId: dto.channel.id } },
    });
    return interaction.editReply({
      content: `**${LOG_NAMES[preset] ?? preset}** logs will be sent to <#${dto.channel.id}>.`,
    });
  }

  @Subcommand({
    name: 'off',
    description: 'Disable a log group',
  })
  async onOff(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsOffDto,
  ) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) return interaction.editReply({ content: 'Server only.' });

    const preset = dto.type as LogPreset;
    await this.settings.update(guildId, { presets: { [preset]: { enabled: false } } });
    return interaction.editReply({
      content: `**${LOG_NAMES[preset] ?? preset}** logs disabled.`,
    });
  }
}
