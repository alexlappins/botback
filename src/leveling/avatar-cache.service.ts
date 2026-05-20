import { Injectable, Logger } from '@nestjs/common';
import { loadImage, type Image } from '@napi-rs/canvas';

/**
 * In-memory LRU cache for decoded Discord avatar images.
 *
 * Why this matters: rank cards are generated on every /rank call AND on every
 * dashboard preview render — without a cache that's a hot loop of fetches to
 * Discord CDN, which is rate-limited. The cache key is the full avatar URL,
 * which already contains the avatar hash, so an avatar change yields a new key
 * and the old entry simply expires.
 *
 * MVP: in-memory single-process Map. If we ever multi-process, swap for Redis.
 */
@Injectable()
export class AvatarCacheService {
  private readonly logger = new Logger(AvatarCacheService.name);
  private readonly maxEntries = 1000;
  private readonly ttlMs = 60 * 60 * 1000; // 1 hour
  private readonly fetchTimeoutMs = 8000;
  private readonly cache = new Map<string, { image: Image; expiresAt: number }>();

  async get(url: string): Promise<Image | null> {
    const now = Date.now();
    const hit = this.cache.get(url);
    if (hit && hit.expiresAt > now) {
      // Bump LRU
      this.cache.delete(url);
      this.cache.set(url, hit);
      return hit.image;
    }
    if (hit) this.cache.delete(url);

    const image = await this.fetch(url);
    if (!image) return null;

    if (this.cache.size >= this.maxEntries) {
      // Drop oldest (first iteration entry — Map preserves insertion order)
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(url, { image, expiresAt: now + this.ttlMs });
    return image;
  }

  private async fetch(url: string): Promise<Image | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.fetchTimeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return await loadImage(buf);
    } catch (e) {
      this.logger.debug(`Avatar fetch failed for ${url}: ${(e as Error).message}`);
      return null;
    }
  }
}
