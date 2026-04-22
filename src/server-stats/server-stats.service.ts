import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ChannelType, Client, Guild, PermissionsBitField } from 'discord.js';
import {
  GuildStorageService,
  type ServerStatsConfig,
} from '../common/storage/guild-storage.service';

/**
 * Клон функции ServerStats-бота: создаёт и обновляет 4 канала-счётчика
 * (Всего / Люди / Боты / В сети) в отдельной категории в самом верху.
 *
 * Discord rate limit: переименование канала — 2 раза в 10 минут. Поэтому апдейтим не чаще чем раз в 10 мин.
 *
 * Названия категории и каналов настраиваются через `nameTemplates`. Плейсхолдер `{count}` заменяется на число.
 */

/** Шаблоны имён для статистики. `{count}` заменяется на число. */
export interface StatsNameTemplates {
  categoryName?: string;
  totalName?: string;
  humansName?: string;
  botsName?: string;
  onlineName?: string;
}

const DEFAULT_NAMES: Required<StatsNameTemplates> = {
  categoryName: '📊 Статистика сервера',
  totalName: '👥 Всего: {count}',
  humansName: '👤 Люди: {count}',
  botsName: '🤖 Боты: {count}',
  onlineName: '🟢 В сети: {count}',
};

@Injectable()
export class ServerStatsService {
  private readonly logger = new Logger(ServerStatsService.name);

  constructor(
    @Inject(Client) private readonly client: Client,
    private readonly storage: GuildStorageService,
  ) {}

  /**
   * Создаёт категорию со статистикой и 4 голосовых канала-счётчика.
   * Возвращает конфиг. Если уже настроено — возвращает существующий (не пересоздаёт).
   * @param templates — кастомные названия (категории и каналов). Если не передано — дефолтные.
   */
  async setup(
    guildId: string,
    templates: StatsNameTemplates = {},
  ): Promise<ServerStatsConfig> {
    const names = { ...DEFAULT_NAMES, ...stripEmpty(templates) };

    const existing = this.storage.getServerStats(guildId);
    if (existing) {
      const guild = await this.resolveGuild(guildId);
      if (guild && guild.channels.cache.get(existing.categoryId)) {
        // Обновим шаблоны имён в хранилище, чтобы новые применились при следующем апдейте
        this.storage.setServerStats(guildId, { ...existing, nameTemplates: templates });
        return existing;
      }
      // категории больше нет — продолжаем и создадим заново
    }

    const guild = await this.resolveGuild(guildId);
    if (!guild) throw new Error('Guild not found');

    // Категория в самом верху (position = 0)
    const category = await guild.channels.create({
      name: names.categoryName,
      type: ChannelType.GuildCategory,
      position: 0,
    });

    // Четыре голосовых канала (чтобы участники не могли зайти — только видеть название)
    const denyConnect = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.Connect],
      },
    ];

    const [total, humans, bots, online] = await Promise.all([
      guild.channels.create({
        name: renderName(names.totalName, 0),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: denyConnect,
      }),
      guild.channels.create({
        name: renderName(names.humansName, 0),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: denyConnect,
      }),
      guild.channels.create({
        name: renderName(names.botsName, 0),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: denyConnect,
      }),
      guild.channels.create({
        name: renderName(names.onlineName, 0),
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: denyConnect,
      }),
    ]);

    const config: ServerStatsConfig = {
      categoryId: category.id,
      totalChannelId: total.id,
      humansChannelId: humans.id,
      botsChannelId: bots.id,
      onlineChannelId: online.id,
      nameTemplates: templates,
    };
    this.storage.setServerStats(guildId, config);

    // Сразу обновить с реальными цифрами
    await this.updateGuild(guild, config).catch((e) => {
      this.logger.warn(`Initial stats update failed for ${guildId}: ${(e as Error).message}`);
    });

    return config;
  }

  /** Удаляет статистику — каналы и категорию. */
  async disable(guildId: string): Promise<void> {
    const config = this.storage.getServerStats(guildId);
    if (!config) return;
    const guild = await this.resolveGuild(guildId);
    if (guild) {
      const ids = [
        config.totalChannelId,
        config.humansChannelId,
        config.botsChannelId,
        config.onlineChannelId,
        config.categoryId,
      ];
      for (const id of ids) {
        const ch = guild.channels.cache.get(id);
        if (ch) await ch.delete().catch(() => null);
      }
    }
    this.storage.removeServerStats(guildId);
  }

  /** Обновить все guild-ы: вызывается кроном раз в 10 минут (rate limit Discord) */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async updateAll(): Promise<void> {
    const entries = this.storage.listGuildsWithServerStats();
    for (const { guildId, config } of entries) {
      const guild = await this.resolveGuild(guildId);
      if (!guild) continue;
      await this.updateGuild(guild, config).catch((e) => {
        this.logger.warn(`Stats update failed for ${guildId}: ${(e as Error).message}`);
      });
    }
  }

  /** Обновить названия каналов для конкретной гильдии */
  private async updateGuild(guild: Guild, config: ServerStatsConfig): Promise<void> {
    // Подгружаем всех участников для точных онлайн-счётчиков (presence intent требуется)
    await guild.members.fetch().catch(() => null);

    const total = guild.memberCount;
    const members = guild.members.cache;
    const humans = members.filter((m) => !m.user.bot).size;
    const bots = members.filter((m) => m.user.bot).size;
    const online = members.filter(
      (m) => !m.user.bot && m.presence?.status && m.presence.status !== 'offline',
    ).size;

    const names = { ...DEFAULT_NAMES, ...stripEmpty(config.nameTemplates ?? {}) };

    const rename = async (channelId: string, newName: string) => {
      const ch = guild.channels.cache.get(channelId);
      if (!ch) return;
      if (ch.name === newName) return; // не трогаем если не изменилось (экономим rate limit)
      await ch.setName(newName).catch(() => null);
    };

    await Promise.all([
      rename(config.totalChannelId, renderName(names.totalName, total)),
      rename(config.humansChannelId, renderName(names.humansName, humans)),
      rename(config.botsChannelId, renderName(names.botsName, bots)),
      rename(config.onlineChannelId, renderName(names.onlineName, online)),
    ]);

    // Название категории тоже синхронизируем (если юзер сменил шаблон)
    const category = guild.channels.cache.get(config.categoryId);
    if (category && category.name !== names.categoryName) {
      await category.setName(names.categoryName).catch(() => null);
    }
  }

  private async resolveGuild(guildId: string): Promise<Guild | null> {
    return (
      this.client.guilds.cache.get(guildId) ??
      (await this.client.guilds.fetch(guildId).catch(() => null))
    );
  }
}

/** Подставляем число в шаблон имени (замена {count}), обрезаем до 100 символов (лимит Discord) */
function renderName(template: string, count: number): string {
  return template.replace(/\{count\}/g, String(count)).slice(0, 100);
}

/** Убираем пустые/whitespace поля — чтобы не перезатереть дефолтные пустой строкой */
function stripEmpty(obj: StatsNameTemplates): Partial<StatsNameTemplates> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.trim()) out[k] = v;
  }
  return out as Partial<StatsNameTemplates>;
}
