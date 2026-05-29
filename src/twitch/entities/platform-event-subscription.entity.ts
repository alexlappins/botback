import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import type { StreamPlatform } from './stream-subscription.entity';

/**
 * Bookkeeping for the actual EventSub / platform-side subscriptions we
 * have created. One {@link StreamSubscription} may have several rows here —
 * for Twitch we create both `stream.online` and `stream.offline`, so two rows
 * per streamer.
 *
 * `platform_subscription_id` is the id returned by Twitch's
 * `POST /helix/eventsub/subscriptions`. We keep it around so we can DELETE
 * the subscription on stream removal, and so the bootstrap reconciliation
 * step knows which Twitch-side subscriptions belong to us.
 *
 * We do NOT store the WebSocket session_id here — it's transient (new on every
 * reconnect). On every fresh `session_welcome` we drop everything in this table
 * for our app and recreate, repopulating `platform_subscription_id`.
 */
@Entity('platform_event_subscriptions')
@Unique('platform_event_subs_uniq', ['streamSubscriptionId', 'eventType'])
@Index(['streamSubscriptionId'])
export class PlatformEventSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'stream_subscription_id', type: 'uuid' })
  streamSubscriptionId: string;

  @Column({ type: 'varchar', length: 16 })
  platform: StreamPlatform;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType: string;

  @Column({ name: 'platform_subscription_id', type: 'varchar', length: 64, nullable: true })
  platformSubscriptionId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
