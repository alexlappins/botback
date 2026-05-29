import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { PlatformEventSubscription } from './entities/platform-event-subscription.entity';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { StreamNotificationsService } from './stream-notifications.service';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchTokenService } from './twitch-token.service';

/**
 * Twitch EventSub WebSocket client.
 *
 *   1. Connect to wss://eventsub.wss.twitch.tv/ws
 *   2. On session_welcome → record session_id, recreate ALL our subscriptions
 *      for the fresh session (session_ids are not reusable across reconnects).
 *   3. On session_keepalive → reset the idle timer (Twitch sends every ~10s).
 *   4. On notification → fan out to StreamNotificationsService.
 *   5. On session_reconnect → connect to the new URL Twitch hands us,
 *      switch over after the new socket gets its welcome.
 *   6. On revocation → drop our DB row for that subscription so the next
 *      reconcile recreates it.
 *
 * We only ever run ONE socket (single-process bot). At ~300 subs per socket
 * we're far from the ceiling; sharding lives in a future iteration.
 *
 * If TwitchTokenService isn't configured (missing client id/secret) the
 * service stays passive — no connect, no errors.
 */
type WelcomeMsg = {
  metadata: { message_type: 'session_welcome' };
  payload: { session: { id: string; status: string; keepalive_timeout_seconds: number } };
};
type KeepaliveMsg = { metadata: { message_type: 'session_keepalive' } };
type ReconnectMsg = {
  metadata: { message_type: 'session_reconnect' };
  payload: { session: { id: string; reconnect_url: string } };
};
type RevocationMsg = {
  metadata: { message_type: 'revocation'; subscription_type: string };
  payload: { subscription: { id: string; type: string; condition: Record<string, string> } };
};
type NotificationMsg = {
  metadata: { message_type: 'notification'; subscription_type: string; message_id: string };
  payload: {
    subscription: { id: string; type: string; condition: Record<string, string> };
    event: Record<string, unknown>;
  };
};
type AnyMsg = WelcomeMsg | KeepaliveMsg | ReconnectMsg | RevocationMsg | NotificationMsg;

const DEFAULT_WSS_URL = 'wss://eventsub.wss.twitch.tv/ws';

@Injectable()
export class TwitchEventSubService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TwitchEventSubService.name);

  private ws: WebSocket | null = null;
  /** Active session id from the most recent welcome. Subscriptions ride on this. */
  private sessionId: string | null = null;
  private keepaliveTimeoutSec = 10;
  private idleTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private shuttingDown = false;
  /** Dedup ring buffer for Twitch message_ids — they retry on missed acks. */
  private readonly recentMessageIds = new Set<string>();
  private readonly recentMessageOrder: string[] = [];

  constructor(
    private readonly tokens: TwitchTokenService,
    private readonly helix: TwitchHelixService,
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
    @InjectRepository(PlatformEventSubscription)
    private readonly platformSubRepo: Repository<PlatformEventSubscription>,
    @Inject(forwardRef(() => StreamNotificationsService))
    private readonly notifier: StreamNotificationsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.tokens.isConfigured()) return;
    // Clear stale platform_subscription_ids — they're tied to a session that
    // is by definition dead now. We'll recreate everything on the next welcome.
    await this.platformSubRepo.update(
      { platformSubscriptionId: Not(IsNull()) },
      { platformSubscriptionId: null },
    );
    this.connect(DEFAULT_WSS_URL);
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearTimers();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  /**
   * Create EventSub subscriptions for a stream-subscription DB row. Called
   * by the command handler / dashboard right after inserting the row.
   * Safe to call even if there's no active session — we'll catch up on the
   * next welcome via {@link recreateAllSubscriptionsForSession}.
   */
  async ensureSubscriptionsFor(stream: StreamSubscription): Promise<void> {
    if (!this.sessionId) {
      // Not connected yet — bootstrap reconciliation will pick this up.
      return;
    }
    const types = ['stream.online', 'stream.offline'];
    for (const type of types) {
      await this.createSubscriptionRow(stream, type);
    }
  }

  /**
   * Delete EventSub subscriptions for a stream-subscription. Called by the
   * command handler before deleting the DB row. Twitch-side: deletes by
   * subscription id; our table row removal is cascaded by FK.
   */
  async removeSubscriptionsFor(streamSubscriptionId: string): Promise<void> {
    const rows = await this.platformSubRepo.find({ where: { streamSubscriptionId } });
    for (const r of rows) {
      if (r.platformSubscriptionId) {
        try {
          await this.helix.deleteEventSubSubscription(r.platformSubscriptionId);
        } catch (e) {
          this.logger.warn(
            `Failed to delete EventSub ${r.platformSubscriptionId}: ${(e as Error).message}`,
          );
        }
      }
    }
    await this.platformSubRepo.delete({ streamSubscriptionId });
  }

  // ── WebSocket lifecycle ──────────────────────────────────

  private connect(url: string): void {
    if (this.shuttingDown) return;
    this.logger.log(`Connecting to Twitch EventSub: ${url}`);
    try {
      const socket = new WebSocket(url);
      this.ws = socket;
      socket.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
      socket.addEventListener('close', (ev) => this.onClose(ev.code, ev.reason));
      socket.addEventListener('error', (ev) => {
        this.logger.warn(`Twitch WS error: ${(ev as ErrorEvent).message ?? 'unknown'}`);
      });
      // Open is implicit — we wait for session_welcome to consider ourselves "up".
    } catch (e) {
      this.logger.error(`WS connect threw: ${(e as Error).message}`);
      this.scheduleReconnect();
    }
  }

  private onClose(code: number, reason: string): void {
    this.logger.warn(`Twitch WS closed: ${code} ${reason || '(no reason)'}`);
    this.sessionId = null;
    this.clearTimers();
    if (this.shuttingDown) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    const backoff = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt);
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectAttempt += 1;
    this.logger.log(`Reconnecting in ${backoff + jitter}ms (attempt ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => this.connect(DEFAULT_WSS_URL), backoff + jitter);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Twitch sends keepalive every ~keepalive_timeout_seconds; if we hear nothing
    // for 3× that, the connection is dead — force reconnect.
    const ms = this.keepaliveTimeoutSec * 3 * 1000;
    this.idleTimer = setTimeout(() => {
      this.logger.warn(`No Twitch WS traffic in ${ms}ms — forcing reconnect`);
      try {
        this.ws?.close();
      } catch {
        // ignore
      }
    }, ms);
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.idleTimer = null;
    this.reconnectTimer = null;
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: AnyMsg;
    try {
      msg = JSON.parse(raw) as AnyMsg;
    } catch (e) {
      this.logger.warn(`Invalid WS payload: ${(e as Error).message}`);
      return;
    }
    this.resetIdleTimer();

    // TS can't narrow `msg` from a nested discriminator (`metadata.message_type`)
    // in a discriminated union — each branch needs an explicit cast. The runtime
    // switch is still the source of truth.
    switch (msg.metadata.message_type) {
      case 'session_welcome':
        await this.handleWelcome(msg as WelcomeMsg);
        break;
      case 'session_keepalive':
        // Idle timer is already reset — nothing to do.
        break;
      case 'session_reconnect':
        await this.handleReconnect(msg as ReconnectMsg);
        break;
      case 'revocation':
        await this.handleRevocation(msg as RevocationMsg);
        break;
      case 'notification':
        await this.handleNotification(msg as NotificationMsg);
        break;
      default:
        // Future-proof: log unknown types but don't crash.
        this.logger.debug(`Unknown WS message_type: ${(msg.metadata as { message_type: string }).message_type}`);
    }
  }

  private async handleWelcome(msg: WelcomeMsg): Promise<void> {
    this.sessionId = msg.payload.session.id;
    this.keepaliveTimeoutSec = msg.payload.session.keepalive_timeout_seconds ?? 10;
    this.reconnectAttempt = 0;
    this.logger.log(`Twitch EventSub session up: ${this.sessionId} (keepalive ${this.keepaliveTimeoutSec}s)`);
    this.resetIdleTimer();
    await this.recreateAllSubscriptionsForSession();
  }

  private async handleReconnect(msg: ReconnectMsg): Promise<void> {
    this.logger.log(`Twitch asked us to reconnect to ${msg.payload.session.reconnect_url}`);
    // Connect to the new URL in parallel — only switch over when its welcome arrives.
    // For simplicity (and because Twitch sends this rarely) we close the old socket
    // and let the standard reconnect path bring up the new one on the default URL.
    // The reconnect_url is preferred for migrations; let's honour it.
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.sessionId = null;
    this.connect(msg.payload.session.reconnect_url);
  }

  private async handleRevocation(msg: RevocationMsg): Promise<void> {
    const subId = msg.payload.subscription.id;
    this.logger.warn(`Twitch revoked subscription ${subId} (${msg.metadata.subscription_type})`);
    await this.platformSubRepo.update({ platformSubscriptionId: subId }, { platformSubscriptionId: null });
    // Next welcome / next manual reconcile will recreate it.
  }

  private async handleNotification(msg: NotificationMsg): Promise<void> {
    // Twitch retries notifications on missed acks; dedup by message_id.
    const id = msg.metadata.message_id;
    if (this.recentMessageIds.has(id)) {
      this.logger.debug(`Dropping duplicate notification ${id}`);
      return;
    }
    this.recentMessageIds.add(id);
    this.recentMessageOrder.push(id);
    if (this.recentMessageOrder.length > 500) {
      const drop = this.recentMessageOrder.shift();
      if (drop) this.recentMessageIds.delete(drop);
    }

    const type = msg.metadata.subscription_type;
    const event = msg.payload.event as Record<string, unknown>;
    try {
      if (type === 'stream.online') {
        await this.notifier.onStreamOnline({
          broadcasterUserId: String(event.broadcaster_user_id),
          broadcasterUserLogin: String(event.broadcaster_user_login ?? ''),
          broadcasterUserName: String(event.broadcaster_user_name ?? ''),
          streamId: String(event.id),
          streamType: String(event.type ?? 'live'),
          startedAt: String(event.started_at ?? new Date().toISOString()),
        });
      } else if (type === 'stream.offline') {
        await this.notifier.onStreamOffline({
          broadcasterUserId: String(event.broadcaster_user_id),
        });
      }
    } catch (e) {
      this.logger.error(
        `Notification handler crashed for ${type}: ${(e as Error).message}`,
        (e as Error).stack,
      );
    }
  }

  // ── Subscription reconciliation ──────────────────────────

  /**
   * Bring Twitch-side subscriptions in line with our DB for the CURRENT session.
   * Runs after every session_welcome. Steps:
   *   1. Clear stale platform_subscription_id rows (different session).
   *   2. For each enabled stream_subscription, create stream.online + stream.offline
   *      if not already present in platform_event_subscriptions for this session.
   *
   * (We don't try to recover the previous session's subscriptions — they're tied
   * to a dead session_id and Twitch drops them automatically.)
   */
  private async recreateAllSubscriptionsForSession(): Promise<void> {
    if (!this.sessionId) return;

    // Defensive: clear any session-bound rows left from a prior session.
    await this.platformSubRepo.update(
      { platformSubscriptionId: Not(IsNull()) },
      { platformSubscriptionId: null },
    );

    const streams = await this.streamRepo.find({ where: { enabled: true, platform: 'twitch' } });
    this.logger.log(`Recreating ${streams.length * 2} EventSub subs on session ${this.sessionId}`);
    for (const s of streams) {
      for (const type of ['stream.online', 'stream.offline']) {
        try {
          await this.createSubscriptionRow(s, type);
        } catch (e) {
          this.logger.warn(
            `Create ${type} for ${s.platformUsername} failed: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  private async createSubscriptionRow(
    stream: StreamSubscription,
    type: string,
  ): Promise<void> {
    if (!this.sessionId) return;
    // Upsert local row first so we have something to attach the Twitch id to.
    let row = await this.platformSubRepo.findOne({
      where: { streamSubscriptionId: stream.id, eventType: type },
    });
    if (!row) {
      row = this.platformSubRepo.create({
        streamSubscriptionId: stream.id,
        platform: 'twitch',
        eventType: type,
      });
      row = await this.platformSubRepo.save(row);
    }
    const created = await this.helix.createWsSubscription({
      type,
      version: '1',
      condition: { broadcaster_user_id: stream.platformUserId },
      sessionId: this.sessionId,
    });
    row.platformSubscriptionId = created.id;
    await this.platformSubRepo.save(row);
  }
}
