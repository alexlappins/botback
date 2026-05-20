import { Injectable } from '@nestjs/common';

/**
 * Short-lived cache of rendered rank-card PNGs.
 *
 * Spec target: 2–5 minutes. Per-server invalidation runs when an admin saves
 * leveling settings; per-user invalidation runs on level-up so the card
 * doesn't lag behind the user's actual XP for the next /rank call.
 */
@Injectable()
export class RankCardCacheService {
  private readonly ttlMs = 3 * 60 * 1000; // 3 minutes
  private readonly maxEntries = 5000;
  private readonly cache = new Map<string, { buf: Buffer; expiresAt: number }>();

  private keyOf(serverId: string, userId: string): string {
    return `${serverId}:${userId}`;
  }

  get(serverId: string, userId: string): Buffer | null {
    const k = this.keyOf(serverId, userId);
    const hit = this.cache.get(k);
    const now = Date.now();
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.cache.delete(k);
      return null;
    }
    this.cache.delete(k);
    this.cache.set(k, hit);
    return hit.buf;
  }

  put(serverId: string, userId: string, buf: Buffer): void {
    const k = this.keyOf(serverId, userId);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(k, { buf, expiresAt: Date.now() + this.ttlMs });
  }

  invalidateUser(serverId: string, userId: string): void {
    this.cache.delete(this.keyOf(serverId, userId));
  }

  /** Called on settings save — every cached card on the server now has stale visuals. */
  invalidateServer(serverId: string): void {
    const prefix = `${serverId}:`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }
}
