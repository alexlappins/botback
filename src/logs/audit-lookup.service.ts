import { Injectable, Logger } from '@nestjs/common';
import { AuditLogEvent, Guild, GuildAuditLogsEntry } from 'discord.js';

interface PendingLookup {
  guild: Guild;
  type: AuditLogEvent;
  targetId: string | null;
  resolve: (entry: GuildAuditLogsEntry | null) => void;
  enqueuedAt: number;
}

const DEBOUNCE_MS = 2_000; // TZ §7: debounce audit requests by 2s
const MATCH_WINDOW_MS = 10_000; // entry must be at most 10s old to match

/**
 * Rate-limit-friendly Audit Log resolver (TZ §7). Lookups for the same
 * (guild, audit type) within the debounce window share ONE API call; entries
 * are matched to events by target_id + a 10-second freshness window.
 * Missing View Audit Log permission → resolves null (callers show fallback).
 */
@Injectable()
export class AuditLookupService {
  private readonly logger = new Logger(AuditLookupService.name);
  private readonly queues = new Map<string, { timer: NodeJS.Timeout; items: PendingLookup[] }>();

  lookup(guild: Guild, type: AuditLogEvent, targetId: string | null): Promise<GuildAuditLogsEntry | null> {
    return new Promise((resolve) => {
      const key = `${guild.id}:${type}`;
      let q = this.queues.get(key);
      if (!q) {
        q = {
          items: [],
          timer: setTimeout(() => void this.flush(key), DEBOUNCE_MS),
        };
        this.queues.set(key, q);
      }
      q.items.push({ guild, type, targetId, resolve, enqueuedAt: Date.now() });
    });
  }

  private async flush(key: string): Promise<void> {
    const q = this.queues.get(key);
    this.queues.delete(key);
    if (!q || q.items.length === 0) return;
    const { guild, type } = q.items[0];

    let entries: GuildAuditLogsEntry[] = [];
    try {
      const logs = await guild.fetchAuditLogs({ type, limit: 10 });
      entries = [...logs.entries.values()];
    } catch {
      // No View Audit Log permission (or transient error) — resolve nulls.
    }

    for (const item of q.items) {
      const entry = entries.find(
        (e) =>
          (item.targetId == null || e.targetId === item.targetId) &&
          Date.now() - e.createdTimestamp < MATCH_WINDOW_MS + (Date.now() - item.enqueuedAt),
      );
      try {
        item.resolve(entry ?? null);
      } catch (e) {
        this.logger.warn(`audit resolve callback failed: ${(e as Error).message}`);
      }
    }
  }

  /** Quick permission probe for the dashboard warning (TZ §2). */
  hasAuditAccess(guild: Guild): boolean {
    return guild.members.me?.permissions.has('ViewAuditLog') ?? false;
  }
}
