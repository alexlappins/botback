import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-guild premium status — the single source of truth read by
 * {@link PremiumService.isPremium}. Only billing/status lives here; feature
 * settings stay in their own tables and are never deleted on expiry (TZ v2.1).
 */
@Entity('guild_subscriptions')
@Index('guild_subscriptions_active_idx', ['active', 'currentPeriodEnd'])
export class GuildSubscription {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  active: boolean;

  @Column({ type: 'varchar', length: 32, default: 'premium' })
  plan: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  provider: string | null;

  @Column({ name: 'external_id', type: 'varchar', length: 128, nullable: true })
  externalId: string | null;

  /** NULL = open-ended grant (manual/admin). A date = billing period end. */
  @Column({ name: 'current_period_end', type: 'timestamptz', nullable: true })
  currentPeriodEnd: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
