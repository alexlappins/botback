import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuildStorageService, LogChannelsConfig } from '../common/storage/guild-storage.service';
import { LogSettings } from './entities/log-settings.entity';
import { LEGACY_TYPE_TO_PRESETS, LOG_PRESETS, LogPreset } from './log-presets';

/** Column pairs per preset — kept here so nothing else string-concatenates. */
const PRESET_COLUMNS: Record<LogPreset, { enabled: keyof LogSettings; channel: keyof LogSettings }> = {
  ban: { enabled: 'banEnabled', channel: 'banChannelId' },
  joinLeave: { enabled: 'joinLeaveEnabled', channel: 'joinLeaveChannelId' },
  messages: { enabled: 'messagesEnabled', channel: 'messagesChannelId' },
  moderation: { enabled: 'moderationEnabled', channel: 'moderationChannelId' },
  channel: { enabled: 'channelEnabled', channel: 'channelChannelId' },
  server: { enabled: 'serverEnabled', channel: 'serverChannelId' },
  voice: { enabled: 'voiceEnabled', channel: 'voiceChannelId' },
};

export interface PresetSettingsInput {
  singleChannelMode?: boolean;
  singleChannelId?: string | null;
  presets?: Partial<Record<LogPreset, { enabled?: boolean; channelId?: string | null }>>;
}

/**
 * Single source of truth for "where does this log preset go" (TZ §1-§3).
 * In-memory cache in front of Postgres — listeners hit this on every event.
 *
 * On boot, guilds configured under the LEGACY per-event system (data/guilds.json)
 * are migrated once (TZ §8): same channel everywhere → single-channel mode with
 * all presets on; per-event channels → the presets covering those events.
 */
@Injectable()
export class LogSettingsService implements OnModuleInit {
  private readonly logger = new Logger(LogSettingsService.name);
  private cache = new Map<string, LogSettings>();

  constructor(
    @InjectRepository(LogSettings)
    private readonly repo: Repository<LogSettings>,
    private readonly legacyStorage: GuildStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.repo.find().catch(() => [] as LogSettings[]);
    for (const row of rows) this.cache.set(row.guildId, row);
    await this.migrateLegacy().catch((e) =>
      this.logger.error(`Legacy log settings migration failed: ${(e as Error).message}`),
    );
    // Legacy writers (template installs, /guilds/:id/logs PUT) still call
    // storage.setLogChannel — mirror those writes into the preset system so
    // nothing configured the old way silently stops logging.
    this.legacyStorage.onLogChannelWrite((guildId, type, channelId) => {
      const presets = LEGACY_TYPE_TO_PRESETS[type] ?? [];
      if (!presets.length) return;
      void this.update(guildId, {
        presets: Object.fromEntries(
          presets.map((p) => [p, channelId ? { enabled: true, channelId } : { enabled: false }]),
        ),
      }).catch((e) => this.logger.warn(`legacy mirror failed: ${(e as Error).message}`));
    });
  }

  /** TZ §8 — one-time import of data/guilds.json log channels. */
  private async migrateLegacy(): Promise<void> {
    const legacy = this.legacyStorage.getAllGuildIds?.() ?? [];
    let migrated = 0;
    for (const guildId of legacy) {
      if (this.cache.has(guildId)) continue;
      const channels = this.legacyStorage.getConfig(guildId).logChannels;
      if (!channels || Object.keys(channels).length === 0) continue;

      const ids = [...new Set(Object.values(channels).filter(Boolean))];
      const row = this.repo.create({ guildId });
      if (ids.length === 1) {
        // One channel for everything → single-channel mode, ALL presets on.
        row.singleChannelMode = true;
        row.singleChannelId = ids[0]!;
        for (const preset of LOG_PRESETS) {
          (row[PRESET_COLUMNS[preset].enabled] as boolean) = true;
        }
      } else {
        for (const [legacyType, channelId] of Object.entries(channels)) {
          if (!channelId) continue;
          for (const preset of LEGACY_TYPE_TO_PRESETS[legacyType] ?? []) {
            (row[PRESET_COLUMNS[preset].enabled] as boolean) = true;
            (row[PRESET_COLUMNS[preset].channel] as string | null) ??= channelId;
          }
        }
      }
      await this.repo.save(row);
      this.cache.set(guildId, row);
      migrated += 1;
    }
    if (migrated) this.logger.log(`Migrated legacy log settings for ${migrated} guild(s)`);
  }

  async getOrCreate(guildId: string): Promise<LogSettings> {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    let row = await this.repo.findOne({ where: { guildId } });
    if (!row) row = this.repo.create({ guildId });
    this.cache.set(guildId, row);
    return row;
  }

  async update(guildId: string, input: PresetSettingsInput): Promise<LogSettings> {
    const row = await this.getOrCreate(guildId);
    if (input.singleChannelMode !== undefined) row.singleChannelMode = input.singleChannelMode;
    if (input.singleChannelId !== undefined) row.singleChannelId = input.singleChannelId;
    for (const preset of LOG_PRESETS) {
      const patch = input.presets?.[preset];
      if (!patch) continue;
      if (patch.enabled !== undefined) (row[PRESET_COLUMNS[preset].enabled] as boolean) = patch.enabled;
      if (patch.channelId !== undefined) (row[PRESET_COLUMNS[preset].channel] as string | null) = patch.channelId;
    }
    const saved = await this.repo.save(row);
    this.cache.set(guildId, saved);
    return saved;
  }

  /**
   * The one call every listener makes: destination channel for a preset, or
   * null when the preset is off / has no channel. Synchronous — cache only.
   */
  channelFor(guildId: string, preset: LogPreset): string | null {
    const row = this.cache.get(guildId);
    if (!row) return null;
    if (!(row[PRESET_COLUMNS[preset].enabled] as boolean)) return null;
    if (row.singleChannelMode) return row.singleChannelId;
    return (row[PRESET_COLUMNS[preset].channel] as string | null) ?? null;
  }

  /** Wire shape for the dashboard. */
  toWire(row: LogSettings) {
    return {
      singleChannelMode: row.singleChannelMode,
      singleChannelId: row.singleChannelId,
      presets: Object.fromEntries(
        LOG_PRESETS.map((p) => [
          p,
          {
            enabled: row[PRESET_COLUMNS[p].enabled] as boolean,
            channelId: (row[PRESET_COLUMNS[p].channel] as string | null) ?? null,
          },
        ]),
      ),
    };
  }
}
