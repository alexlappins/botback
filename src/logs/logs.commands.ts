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
  { name: 'Вход / Выход (join-leave)', value: 'joinLeave' },
  { name: 'Сообщения (messages)', value: 'messages' },
  { name: 'Модерация (moderation)', value: 'moderation' },
  { name: 'Каналы (channel)', value: 'channel' },
  { name: 'Бан / Кик (ban-kick)', value: 'banKick' },
] as const;

const LOG_NAMES: Record<string, string> = {
  joinLeave: 'Вход / Выход',
  messages: 'Сообщения',
  moderation: 'Модерация',
  channel: 'Каналы',
  banKick: 'Бан / Кик',
};

class LogsSetDto {
  @StringOption({
    name: 'тип',
    description: 'Тип логов',
    required: true,
    choices: [...LOG_TYPE_CHOICES],
  })
  type: string;

  @ChannelOption({
    name: 'канал',
    description: 'Канал для логов',
    required: true,
  })
  channel: { id: string };
}

class LogsOffDto {
  @StringOption({
    name: 'тип',
    description: 'Тип логов',
    required: true,
    choices: [...LOG_TYPE_CHOICES],
  })
  type: string;
}

const LogsGroup = createCommandGroupDecorator({
  name: 'logs',
  description: 'Настройка каналов для логов событий на сервере',
});

@LogsGroup()
@Injectable()
export class LogsCommands {
  constructor(private readonly storage: GuildStorageService) {}

  @Subcommand({
    name: 'set',
    description: 'Указать канал для типа логов',
  })
  async onSet(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsSetDto,
  ) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Команда только для сервера.' });
    }

    const key = dto.type as keyof LogChannelsConfig;
    this.storage.setLogChannel(guildId, key, dto.channel.id);

    return interaction.editReply({
      content: `Логи **${LOG_NAMES[key] ?? key}** будут отправляться в <#${dto.channel.id}>.`,
    });
  }

  @Subcommand({
    name: 'off',
    description: 'Отключить логи определённого типа',
  })
  async onOff(
    @Context() [interaction]: SlashCommandContext,
    @Options() dto: LogsOffDto,
  ) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.editReply({ content: 'Команда только для сервера.' });
    }
    const key = dto.type as keyof LogChannelsConfig;
    this.storage.setLogChannel(guildId, key, null);
    return interaction.editReply({
      content: `Логи типа **${LOG_NAMES[key] ?? key}** отключены.`,
    });
  }
}
