import { Injectable, Logger } from '@nestjs/common';

import { TwitchTokenService } from './twitch-token.service';

export interface TwitchUser {
  id: string;
  login: string;          // lowercase username
  display_name: string;
  profile_image_url: string;
}

export interface TwitchStream {
  id: string;             // stream id (unique per broadcast)
  user_id: string;
  user_login: string;
  user_name: string;
  game_id: string;
  game_name: string;
  type: 'live' | '';
  title: string;
  viewer_count: number;
  started_at: string;     // ISO timestamp
  language: string;
  thumbnail_url: string;  // includes {width} {height} placeholders
}

export interface EventSubSubscription {
  id: string;
  status:
    | 'enabled'
    | 'webhook_callback_verification_pending'
    | 'webhook_callback_verification_failed'
    | 'notification_failures_exceeded'
    | 'authorization_revoked'
    | 'user_removed'
    | 'version_removed'
    | string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: { method: 'websocket' | 'webhook'; session_id?: string; callback?: string };
  created_at: string;
}

/**
 * Thin typed wrapper over a few Helix endpoints we need. Auto-attaches the
 * app token from {@link TwitchTokenService} and transparently retries once
 * on 401 (token expired between cache and request).
 */
@Injectable()
export class TwitchHelixService {
  private readonly logger = new Logger(TwitchHelixService.name);
  private readonly base = 'https://api.twitch.tv/helix';

  constructor(private readonly tokens: TwitchTokenService) {}

  /** Resolve usernames to broadcaster info. Returns only what Twitch found. */
  async getUsersByLogin(logins: string[]): Promise<TwitchUser[]> {
    if (!logins.length) return [];
    const qs = new URLSearchParams();
    for (const l of logins) qs.append('login', l.toLowerCase());
    const data = await this.callJson<{ data: TwitchUser[] }>(`${this.base}/users?${qs}`);
    return data.data;
  }

  /** Snapshot of currently-live streams for a batch of broadcaster ids (max 100). */
  async getStreamsByUserIds(userIds: string[]): Promise<TwitchStream[]> {
    if (!userIds.length) return [];
    const qs = new URLSearchParams();
    for (const id of userIds.slice(0, 100)) qs.append('user_id', id);
    const data = await this.callJson<{ data: TwitchStream[] }>(`${this.base}/streams?${qs}`);
    return data.data;
  }

  /**
   * List EventSub subscriptions our app owns. Used at startup to reconcile
   * Twitch-side state with our DB (drop strangers, recreate misses).
   */
  async listEventSubSubscriptions(
    status?: 'enabled' | 'webhook_callback_verification_pending',
  ): Promise<EventSubSubscription[]> {
    const all: EventSubSubscription[] = [];
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (cursor) qs.set('after', cursor);
      const page = await this.callJson<{
        data: EventSubSubscription[];
        pagination?: { cursor?: string };
      }>(`${this.base}/eventsub/subscriptions?${qs}`);
      all.push(...page.data);
      cursor = page.pagination?.cursor;
    } while (cursor);
    return all;
  }

  /**
   * Create an EventSub subscription via Webhook transport.
   *
   * Twitch will immediately hit `callback` with a challenge handshake; the
   * subscription stays in `webhook_callback_verification_pending` until we
   * answer 200 + plaintext challenge. Only then does it flip to `enabled`
   * and start delivering events.
   *
   * Note: app access token + webhook is the only legal Twitch combo here —
   * websocket transport requires per-broadcaster user tokens, which would
   * mean every streamer OAuthing the bot. Not what we want.
   */
  async createWebhookSubscription(args: {
    type: string;
    version: string;
    condition: Record<string, string>;
    callback: string;
    secret: string;
  }): Promise<EventSubSubscription> {
    const body = {
      type: args.type,
      version: args.version,
      condition: args.condition,
      transport: {
        method: 'webhook',
        callback: args.callback,
        secret: args.secret,
      },
    };
    const data = await this.callJson<{ data: EventSubSubscription[] }>(
      `${this.base}/eventsub/subscriptions`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    return data.data[0];
  }

  /** Delete an EventSub subscription by Twitch subscription id. 404 is treated as success. */
  async deleteEventSubSubscription(id: string): Promise<void> {
    const res = await this.callRaw(`${this.base}/eventsub/subscriptions?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.status !== 204 && res.status !== 404) {
      const text = await res.text().catch(() => '');
      throw new Error(`Delete subscription ${id} failed: ${res.status} ${text}`);
    }
  }

  // ── Internals ────────────────────────────────────────────

  private async callJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.callRaw(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Helix ${init.method ?? 'GET'} ${url} → ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  private async callRaw(url: string, init: RequestInit = {}): Promise<Response> {
    const exec = async (): Promise<Response> => {
      const token = await this.tokens.getToken();
      return fetch(url, {
        ...init,
        headers: {
          'Client-Id': this.tokens.getClientId(),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    };
    let res = await exec();
    // Token might have expired between the cache hit and the request — retry once.
    if (res.status === 401) {
      this.logger.debug('Helix 401 — refreshing token and retrying once');
      this.tokens.invalidate();
      res = await exec();
    }
    return res;
  }
}
