import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PlatformEventSubscription } from './entities/platform-event-subscription.entity';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchTokenService } from './twitch-token.service';

/**
 * Owns the Twitch-side state for our EventSub subscriptions.
 *
 * Webhook transport (vs the old WebSocket one):
 *   - Subscriptions persist across bot restarts — Twitch keeps them in its own
 *     store. No session_id, no keepalive, no reconnect machinery.
 *   - On bootstrap we reconcile: pull what Twitch thinks we own, line it up
 *     with our DB, and add what's missing. Stale subs at Twitch (e.g. ones we
 *     forgot to delete) get cleaned up.
 *   - Add/remove flows mirror the WS ones — same public method names so the
 *     admin service doesn't care which transport we use.
 */
@Injectable()
export class TwitchSubscriptionManagerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TwitchSubscriptionManagerService.name);
  private readonly subscriptionTypes = ['stream.online', 'stream.offline'];

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: TwitchTokenService,
    private readonly helix: TwitchHelixService,
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
    @InjectRepository(PlatformEventSubscription)
    private readonly platformSubRepo: Repository<PlatformEventSubscription>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.tokens.isConfigured()) return;
    if (!this.webhookConfigured()) {
      this.logger.warn(
        'TWITCH_WEBHOOK_CALLBACK_URL / TWITCH_WEBHOOK_SECRET not set — Twitch subscriptions cannot be created. Fill them in .env and restart.',
      );
      return;
    }
    try {
      await this.reconcile();
    } catch (e) {
      this.logger.error(`Twitch bootstrap reconcile failed: ${(e as Error).message}`);
    }
  }

  /** Create stream.online + stream.offline subs for a new DB row. */
  async ensureSubscriptionsFor(stream: StreamSubscription): Promise<void> {
    if (!this.tokens.isConfigured() || !this.webhookConfigured()) {
      this.logger.warn(`Skipping ensureSubscriptionsFor(${stream.platformUsername}) — Twitch not configured`);
      return;
    }
    for (const type of this.subscriptionTypes) {
      await this.createOne(stream, type);
    }
  }

  /** Delete all platform-side subs for a stream-subscription row, then drop our mapping. */
  async removeSubscriptionsFor(streamSubscriptionId: string): Promise<void> {
    const rows = await this.platformSubRepo.find({ where: { streamSubscriptionId } });
    for (const r of rows) {
      if (r.platformSubscriptionId) {
        try {
          await this.helix.deleteEventSubSubscription(r.platformSubscriptionId);
        } catch (e) {
          this.logger.warn(
            `Failed to delete Twitch subscription ${r.platformSubscriptionId}: ${(e as Error).message}`,
          );
        }
      }
    }
    await this.platformSubRepo.delete({ streamSubscriptionId });
  }

  // ── Bootstrap reconciliation ─────────────────────────────

  private async reconcile(): Promise<void> {
    const remote = await this.helix.listEventSubSubscriptions();
    const ourCallback = this.callbackUrl();
    // Only touch subscriptions pointing at our callback URL — other apps
    // sharing the same TWITCH_CLIENT_ID (none today, but futureproof) shouldn't
    // see their subs get nuked.
    const ours = remote.filter(
      (r) => r.transport.method === 'webhook' && r.transport.callback === ourCallback,
    );

    // Build lookup: (broadcaster_user_id + type) → remote subscription row.
    const remoteByKey = new Map<string, (typeof ours)[number]>();
    for (const r of ours) {
      const key = `${r.condition.broadcaster_user_id}/${r.type}`;
      remoteByKey.set(key, r);
    }

    const streams = await this.streamRepo.find({ where: { platform: 'twitch', enabled: true } });
    this.logger.log(
      `Reconciling Twitch subs: ${streams.length} streamers × ${this.subscriptionTypes.length} types, ${ours.length} live at Twitch`,
    );

    // 1) For each desired (streamer, type), make sure both Twitch + our DB
    //    agree. Recreate misses; sync our platform_subscription_id.
    const seenRemoteIds = new Set<string>();
    for (const s of streams) {
      for (const type of this.subscriptionTypes) {
        const key = `${s.platformUserId}/${type}`;
        const remoteSub = remoteByKey.get(key);
        let dbRow = await this.platformSubRepo.findOne({
          where: { streamSubscriptionId: s.id, eventType: type },
        });
        if (remoteSub && (remoteSub.status === 'enabled' || remoteSub.status.startsWith('webhook_callback_verification_pending'))) {
          // All good Twitch-side; just make sure DB has the id.
          if (!dbRow) {
            dbRow = await this.platformSubRepo.save(
              this.platformSubRepo.create({
                streamSubscriptionId: s.id,
                platform: 'twitch',
                eventType: type,
                platformSubscriptionId: remoteSub.id,
              }),
            );
          } else if (dbRow.platformSubscriptionId !== remoteSub.id) {
            dbRow.platformSubscriptionId = remoteSub.id;
            await this.platformSubRepo.save(dbRow);
          }
          seenRemoteIds.add(remoteSub.id);
          continue;
        }
        // Either Twitch lost it (revoked / failed / never created) or it's in
        // a bad state. Drop the bad remote sub (if any) and recreate.
        if (remoteSub) {
          try {
            await this.helix.deleteEventSubSubscription(remoteSub.id);
          } catch {
            // best-effort
          }
          seenRemoteIds.add(remoteSub.id);
        }
        try {
          await this.createOne(s, type);
        } catch (e) {
          this.logger.warn(
            `Recreate ${type} for ${s.platformUsername} failed: ${(e as Error).message}`,
          );
        }
      }
    }

    // 2) Garbage-collect: any remote sub we own but don't track in DB is a zombie.
    for (const r of ours) {
      if (seenRemoteIds.has(r.id)) continue;
      this.logger.log(`Garbage-collecting orphan Twitch sub ${r.id} (${r.type})`);
      try {
        await this.helix.deleteEventSubSubscription(r.id);
      } catch (e) {
        this.logger.warn(`Delete orphan ${r.id} failed: ${(e as Error).message}`);
      }
    }
  }

  // ── Single subscription create ───────────────────────────

  private async createOne(stream: StreamSubscription, type: string): Promise<void> {
    let row = await this.platformSubRepo.findOne({
      where: { streamSubscriptionId: stream.id, eventType: type },
    });
    if (!row) {
      row = await this.platformSubRepo.save(
        this.platformSubRepo.create({
          streamSubscriptionId: stream.id,
          platform: 'twitch',
          eventType: type,
        }),
      );
    }
    const created = await this.helix.createWebhookSubscription({
      type,
      version: '1',
      condition: { broadcaster_user_id: stream.platformUserId },
      callback: this.callbackUrl(),
      secret: this.config.getOrThrow<string>('TWITCH_WEBHOOK_SECRET'),
    });
    row.platformSubscriptionId = created.id;
    await this.platformSubRepo.save(row);
    this.logger.log(
      `Created ${type} for ${stream.platformUsername}: ${created.id} (status ${created.status})`,
    );
  }

  // ── Helpers ──────────────────────────────────────────────

  webhookConfigured(): boolean {
    return Boolean(
      this.config.get<string>('TWITCH_WEBHOOK_CALLBACK_URL') &&
        this.config.get<string>('TWITCH_WEBHOOK_SECRET'),
    );
  }

  getStatus(): {
    configured: boolean;
    webhookConfigured: boolean;
    callbackUrl: string | null;
  } {
    return {
      configured: this.tokens.isConfigured(),
      webhookConfigured: this.webhookConfigured(),
      callbackUrl: this.config.get<string>('TWITCH_WEBHOOK_CALLBACK_URL') ?? null,
    };
  }

  private callbackUrl(): string {
    return this.config.getOrThrow<string>('TWITCH_WEBHOOK_CALLBACK_URL');
  }
}
