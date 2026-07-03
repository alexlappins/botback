import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type ScheduleKind = 'once' | 'daily' | 'weekly' | 'monthly';
export type ScheduleStatus = 'active' | 'paused' | 'done';

/**
 * A scheduled or recurring publication of a message payload to a channel
 * (TZ v2.1 §2). Premium-gated at the API; existing rows survive expiry and
 * silently pause (checked in the tick), resuming on renewal.
 */
@Entity('scheduled_posts')
@Index('scheduled_posts_guild_idx', ['guildId'])
export class ScheduledPost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'channel_id', type: 'varchar', length: 32 })
  channelId: string;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  @Column({ name: 'embed_json', type: 'jsonb', nullable: true })
  embedJson: Record<string, unknown> | null;

  @Column({ name: 'components_json', type: 'jsonb', nullable: true })
  componentsJson: unknown[] | null;

  @Column({ type: 'varchar', length: 16 })
  kind: ScheduleKind;

  /** 'HH:MM' in UTC — recurring kinds only. */
  @Column({ name: 'time_of_day', type: 'varchar', length: 5, nullable: true })
  timeOfDay: string | null;

  /** 0=Sun … 6=Sat — weekly only. */
  @Column({ name: 'days_of_week', type: 'int', array: true, nullable: true })
  daysOfWeek: number[] | null;

  /** 1–31 — monthly only (clamped to month length at compute time). */
  @Column({ name: 'day_of_month', type: 'int', nullable: true })
  dayOfMonth: number | null;

  @Column({ name: 'next_run_at', type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  @Column({ name: 'last_run_at', type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: ScheduleStatus;

  @Column({ name: 'run_count', type: 'int', default: 0 })
  runCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
