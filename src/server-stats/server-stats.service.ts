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
  categoryName: '📊 Server Stats',
  totalName: '👥 Total: {count}',
  humansName: '👤 Humans: {count}',
  botsName: '🤖 Bots: {count}',
  onlineName: '🟢 Online: {count}',
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
    this.logger.log(
      `[ServerStats] setup(${guildId}) — names: category="${names.categoryName}" total="${names.totalName}"`,
    );

    const existing = this.storage.getServerStats(guildId);
    if (existing) {
      const guild = await this.resolveGuild(guildId);
      if (guild && guild.channels.cache.get(existing.categoryId)) {
        this.logger.log(
          `[ServerStats] existing config found for ${guildId}, category still exists — updating name templates only`,
        );
        // Обновим шаблоны имён в хранилище, чтобы новые применились при следующем апдейте
        this.storage.setServerStats(guildId, { ...existing, nameTemplates: templates });
        // Сразу применим новые имена (не ждать крон)
        await this.updateGuild(guild, { ...existing, nameTemplates: templates }).catch((e) =>
          this.logger.warn(`[ServerStats] immediate rename failed: ${(e as Error).message}`),
        );
        return existing;
      }
      this.logger.log(
        `[ServerStats] stale config for ${guildId} — category not found, will recreate`,
      );
      // сбрасываем старый stale конфиг
      this.storage.removeServerStats(guildId);
    }

    const guild = await this.resolveGuild(guildId);
    if (!guild) {
      this.logger.error(`[ServerStats] cannot resolve guild ${guildId}`);
      throw new Error('Guild not found');
    }

    // Перед созданием — проверяем, нет ли уже категории с таким именем на гильдии.
    // Это спасает от дублирования если шаблон содержит ту же категорию в TemplateCategory
    // или если она была создана раньше другим способом.
    await guild.channels.fetch().catch(() => null);
    const existingCategoryByName = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === names.categoryName,
    );
    let category;
    if (existingCategoryByName) {
      this.logger.log(
        `[ServerStats] reusing existing category "${names.categoryName}" (id=${existingCategoryByName.id})`,
      );
      category = existingCategoryByName;
    } else {
      this.logger.log(`[ServerStats] creating category "${names.categoryName}" in guild ${guild.id}`);
      category = await guild.channels.create({
        name: names.categoryName,
        type: ChannelType.GuildCategory,
        position: 0,
      });
      this.logger.log(`[ServerStats] category created: id=${category.id}`);
    }

    // Четыре голосовых канала (чтобы участники не могли зайти — только видеть название)
    const denyConnect = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.Connect],
      },
    ];

    // Helper: ищет канал по имени под нашей категорией и реюзит, иначе создаёт новый.
    // Учитывает что Discord может префиксовать названия (например "📊 Total: 0").
    // Сравниваем по основе шаблона без числа.
    const findOrCreateCounter = async (
      template: string,
    ): Promise<{ id: string; name: string }> => {
      const stub = renderName(template, 0); // "👥 Total: 0"
      // Берём префикс до подставленного числа — для матча после переименований
      const prefix = template.split('{count}')[0]; // "👥 Total: "
      const existing = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildVoice &&
          'parentId' in c &&
          (c as { parentId?: string | null }).parentId === category.id &&
          (c.name === stub || (prefix && c.name.startsWith(prefix))),
      );
      if (existing) return { id: existing.id, name: existing.name };
      const created = await guild.channels.create({
        name: stub,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: denyConnect,
      });
      return { id: created.id, name: created.name };
    };

    const [total, humans, bots, online] = await Promise.all([
      findOrCreateCounter(names.totalName),
      findOrCreateCounter(names.humansName),
      findOrCreateCounter(names.botsName),
      findOrCreateCounter(names.onlineName),
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
