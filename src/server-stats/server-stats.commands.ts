import { Injectable } from '@nestjs/common';
import { Context, SlashCommand } from 'necord';
import type { SlashCommandContext } from 'necord';
import { ServerStatsService } from './server-stats.service';

@Injectable()
export class ServerStatsCommands {
  constructor(private readonly stats: ServerStatsService) {}

  @SlashCommand({
    name: 'serverstats-enable',
    description: 'Enable server stats: category with 4 counter channels',
    defaultMemberPermissions: '8', // ADMINISTRATOR
  })
  async onEnable(@Context() [interaction]: SlashCommandContext) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      return interaction.editReply({ content: 'Server only.' });
    }
    try {
      await this.stats.setup(interaction.guildId);
      return interaction.editReply({
        content:
          'Stats enabled. Category and 4 counter channels created at the top. Updates every 10 minutes.',
      });
    } catch (e) {
      return interaction.editReply({
        content: `Failed to create stats: ${(e as Error).message}`,
      });
    }
  }

  @SlashCommand({
    name: 'serverstats-disable',
    description: 'Disable server stats (delete the category and counter channels)',
    defaultMemberPermissions: '8',
  })
  async onDisable(@Context() [interaction]: SlashCommandContext) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      return interaction.editReply({ content: 'Server only.' });
    }
    try {
      await this.stats.disable(interaction.guildId);
      return interaction.editReply({ content: 'Stats disabled — channels removed.' });
    } catch (e) {
      return interaction.editReply({
        content: `Disable error: ${(e as Error).message}`,
      });
    }
  }
}
