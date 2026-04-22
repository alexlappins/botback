import { Injectable } from '@nestjs/common';
import { Context, SlashCommand } from 'necord';
import type { SlashCommandContext } from 'necord';
import { ServerStatsService } from './server-stats.service';

@Injectable()
export class ServerStatsCommands {
  constructor(private readonly stats: ServerStatsService) {}

  @SlashCommand({
    name: 'serverstats-enable',
    description: 'Включить статистику сервера: категория с 4 каналами-счётчиками',
    defaultMemberPermissions: '8', // ADMINISTRATOR
  })
  async onEnable(@Context() [interaction]: SlashCommandContext) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      return interaction.editReply({ content: 'Команда только для сервера.' });
    }
    try {
      await this.stats.setup(interaction.guildId);
      return interaction.editReply({
        content:
          'Статистика включена. Категория и 4 канала-счётчика созданы вверху. Обновление — раз в 10 минут.',
      });
    } catch (e) {
      return interaction.editReply({
        content: `Не удалось создать статистику: ${(e as Error).message}`,
      });
    }
  }

  @SlashCommand({
    name: 'serverstats-disable',
    description: 'Отключить статистику сервера (удалить категорию и каналы-счётчики)',
    defaultMemberPermissions: '8',
  })
  async onDisable(@Context() [interaction]: SlashCommandContext) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) {
      return interaction.editReply({ content: 'Команда только для сервера.' });
    }
    try {
      await this.stats.disable(interaction.guildId);
      return interaction.editReply({ content: 'Статистика отключена — каналы удалены.' });
    } catch (e) {
      return interaction.editReply({
        content: `Ошибка отключения: ${(e as Error).message}`,
      });
    }
  }
}
