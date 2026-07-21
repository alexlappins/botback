import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Client,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
} from 'discord.js';
import { createHash } from 'crypto';

import { PremiumService } from '../premium/premium.service';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { ScheduleSyncMapEntry, ScheduleSyncSettings } from './entities/twitch-features.entities';
import { TwitchHelixService } from './twitch-helix.service';

const SYNC_DAYS = 14; // §1.3
const MAX_EVENTS = 20;

interface TwitchSegment {
  id: string;
  start_time: string;
  end_time: string | null;
  title: string;
  canceled_until: string | null;
  category: { name: string } | null;
  broadcasterLogin: string;
  broadcasterName: string;
}

/**
 * Schedule Sync (TZ-B §1, Premium): Twitch stream schedule → Discord
 * External Scheduled Events. App-token API, no streamer OAuth needed.
 * Segment↔event mapping prevents duplicates; edits update, cancels delete.
 * Premium expiry stops the sync but never deletes existing events (§1.6).
 */
@Injectable()
export class ScheduleSyncService {
  private readonly logger = new Logger(ScheduleSyncService.name);

  constructor(
    @InjectRepository(ScheduleSyncSettings)
    private readonly settingsRepo: Repository<ScheduleSyncSettings>,
    @InjectRepository(ScheduleSyncMapEntry)
    private readonly mapRepo: Repository<ScheduleSyncMapEntry>,
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
    private readonly helix: TwitchHelixService,
    private readonly premium: PremiumService,
    @Inject(Client) private readonly discord: Client,
  ) {}

  async getSettings(guildId: string): Promise<ScheduleSyncSettings> {
    let row = await this.settingsRepo.findOne({ where: { guildId } });
    if (!row) {
      row = this.settingsRepo.create({
        guildId,
        enabled: false,
        sourceSubs: [],
        titleTemplate: null,
        descriptionTemplate: null,
        coverUrl: null,
      });
    }
    return row;
  }

  async updateSettings(guildId: string, patch: Partial<ScheduleSyncSettings>): Promise<ScheduleSyncSettings> {
    const row = await this.getSettings(guildId);
    Object.assign(row, patch, { guildId });
    return this.settingsRepo.save(row);
  }

  /** §1.5 — Manage Events permission probe for the UI. */
  hasManageEvents(guildId: string): boolean {
    const guild = this.discord.guilds.cache.get(guildId);
    return guild?.members.me?.permissions.has('ManageEvents') ?? false;
  }

  @Cron(CronExpression.EVERY_6_HOURS, { name: 'twitch.schedule_sync' })
  async syncAll(): Promise<void> {
    const rows = await this.settingsRepo.find({ where: { enabled: true } });
    for (const row of rows) {
      await this.syncGuild(row.guildId).catch((e) =>
        this.logger.warn(`schedule sync failed for ${row.guildId}: ${(e as Error).message}`),
      );
    }
  }

  /** §1.2 "Sync now" + the cron path. */
  async syncGuild(guildId: string): Promise<{ created: number; updated: number; deleted: number }> {
    const result = { created: 0, updated: 0, deleted: 0 };
    if (!(await this.premium.isPremium(guildId))) return result; // §1.6
    const settings = await this.getSettings(guildId);
    if (!settings.enabled) return result;
    const guild = this.discord.guilds.cache.get(guildId);
    if (!guild || !this.hasManageEvents(guildId)) return result;

    // Source channels: chosen subs or all tracked.
    let subs = await this.streamRepo.find({ where: { guildId, platform: 'twitch' } });
    if (settings.sourceSubs.length) subs = subs.filter((s) => settings.sourceSubs.includes(s.id));
    if (!subs.length) return result;

    // Collect segments 14 days ahead, capped to 20 events (§1.3).
    const horizon = Date.now() + SYNC_DAYS * 86_400_000;
    const segments: TwitchSegment[] = [];
    for (const sub of subs) {
      const segs = await this.fetchSchedule(sub.platformUserId).catch(() => [] as TwitchSegment[]);
      for (const seg of segs) {
        if (new Date(seg.start_time).getTime() > horizon) continue;
        if (new Date(seg.start_time).getTime() < Date.now()) continue;
        segments.push({ ...seg, broadcasterLogin: sub.platformUsername, broadcasterName: sub.platformUsername });
      }
    }
    segments.sort((a, b) => a.start_time.localeCompare(b.start_time));
    const active = segments.filter((s) => !s.canceled_until).slice(0, MAX_EVENTS);
    const activeIds = new Set(active.map((s) => s.id));

    const mapRows = await this.mapRepo.find({ where: { guildId } });
    const mapBySegment = new Map(mapRows.map((m) => [m.segmentId, m]));

    // Create / update.
    for (const seg of active) {
      const fingerprint = createHash('sha1')
        .update(`${seg.start_time}|${seg.title}|${seg.category?.name ?? ''}`)
        .digest('hex');
      const name = (settings.titleTemplate?.trim() || '{streamer} — {title}')
        .replaceAll('{streamer}', seg.broadcasterName)
        .replaceAll('{title}', seg.title || 'Stream')
        .replaceAll('{category}', seg.category?.name ?? '')
        .slice(0, 100);
      const description = (settings.descriptionTemplate?.trim() || 'Watch live on Twitch: https://twitch.tv/{streamer}')
        .replaceAll('{streamer}', seg.broadcasterLogin)
        .replaceAll('{title}', seg.title || '')
        .replaceAll('{category}', seg.category?.name ?? '')
        .slice(0, 1000);

      const existing = mapBySegment.get(seg.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          const ev = await guild.scheduledEvents.fetch(existing.discordEventId).catch(() => null);
          if (ev) {
            await ev
              .edit({
                name,
                description,
                scheduledStartTime: new Date(seg.start_time),
                scheduledEndTime: seg.end_time
                  ? new Date(seg.end_time)
                  : new Date(new Date(seg.start_time).getTime() + 2 * 3600_000),
              })
              .catch(() => null);
            result.updated += 1;
          }
          existing.fingerprint = fingerprint;
          await this.mapRepo.save(existing);
        }
        continue;
      }

      try {
        const ev = await guild.scheduledEvents.create({
          name,
          description,
          scheduledStartTime: new Date(seg.start_time),
          scheduledEndTime: seg.end_time
            ? new Date(seg.end_time)
            : new Date(new Date(seg.start_time).getTime() + 2 * 3600_000),
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: GuildScheduledEventEntityType.External,
          entityMetadata: { location: `https://twitch.tv/${seg.broadcasterLogin}` },
          ...(settings.coverUrl ? { image: settings.coverUrl } : {}),
        });
        await this.mapRepo.save(
          this.mapRepo.create({ guildId, segmentId: seg.id, discordEventId: ev.id, fingerprint }),
        );
        result.created += 1;
      } catch (e) {
        this.logger.warn(`create event failed (${guildId}): ${(e as Error).message}`);
      }
    }

    // Delete cancelled/removed segments (§1.3).
    for (const row of mapRows) {
      if (activeIds.has(row.segmentId)) continue;
      const ev = await guild.scheduledEvents.fetch(row.discordEventId).catch(() => null);
      if (ev) {
        // Only delete future events we created; past events die naturally.
        if (!ev.scheduledStartAt || ev.scheduledStartAt.getTime() > Date.now()) {
          await ev.delete().catch(() => null);
          result.deleted += 1;
        }
      }
      await this.mapRepo.delete({ id: row.id });
    }

    this.logger.log(
      `Schedule sync ${guildId}: +${result.created} ~${result.updated} -${result.deleted}`,
    );
    return result;
  }

  private async fetchSchedule(broadcasterId: string): Promise<TwitchSegment[]> {
    const data = await this.helix.getChannelSchedule(broadcasterId);
    return (data ?? []) as TwitchSegment[];
  }
}
