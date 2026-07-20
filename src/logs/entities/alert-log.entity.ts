import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Alert firing history (TZ §6) — powers the 30-minute cooldown, aggregation
 * bookkeeping and the future Security Report.
 */
@Entity('alert_log')
@Index('alert_log_guild_detector_idx', ['guildId', 'detector', 'createdAt'])
export class AlertLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  /** d1..d9 */
  @Column({ type: 'varchar', length: 8 })
  detector: string;

  /** 'critical' | 'warning' */
  @Column({ type: 'varchar', length: 16 })
  severity: string;

  @Column({ type: 'text' })
  summary: string;

  @Column({ name: 'actor_user_id', type: 'varchar', length: 32, nullable: true })
  actorUserId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
