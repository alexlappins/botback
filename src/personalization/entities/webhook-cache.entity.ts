import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Cache of the service webhook we own per channel (TZ v2.1 §8.6). The webhook
 * itself is named "Level Up Bot Personalization" (a constant service name);
 * the customer-visible name/avatar are per-message overrides on send.
 */
@Entity('webhook_cache')
export class WebhookCache {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @PrimaryColumn({ name: 'channel_id', type: 'varchar', length: 32 })
  channelId: string;

  @Column({ name: 'webhook_id', type: 'varchar', length: 32 })
  webhookId: string;

  @Column({ name: 'webhook_url', type: 'text' })
  webhookUrl: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
