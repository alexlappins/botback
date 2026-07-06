import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Audit trail for manual subscription operations in the owner admin
 * (Misha's TZ §15.5): who granted/cancelled what, for how long, and why.
 * Append-only — rows are never updated or deleted.
 */
@Entity('subscription_audit_log')
@Index('subscription_audit_log_guild_idx', ['guildId'])
export class SubscriptionAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 'grant' | 'cancel' */
  @Column({ type: 'varchar', length: 16 })
  action: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'guild_name', type: 'varchar', length: 256, nullable: true })
  guildName: string | null;

  @Column({ name: 'admin_id', type: 'varchar', length: 32 })
  adminId: string;

  @Column({ name: 'admin_name', type: 'varchar', length: 128, nullable: true })
  adminName: string | null;

  /** Grant length in days; null for open-ended grants and cancels. */
  @Column({ name: 'duration_days', type: 'int', nullable: true })
  durationDays: number | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** Subscription source at the time of the operation: 'manual' | 'stripe'. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  source: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
