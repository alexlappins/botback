import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type PendingInstallStatus = 'waiting_server' | 'deploying' | 'completed' | 'failed';

/**
 * One installation attempt of a purchased server (TZ-2 §3).
 *
 * Lifecycle: waiting_server → (guildCreate autodetect or manual trigger)
 * → deploying → completed | failed. Only one non-terminal pending per
 * purchase; a waiting row older than 24h counts as failed. Attempts are
 * unlimited — the purchase is "used" only after a COMPLETED deploy.
 */
@Entity('pending_installs')
@Index('pending_installs_user_idx', ['discordUserId', 'status'])
export class PendingInstall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'purchase_id', type: 'uuid' })
  purchaseId: string;

  @Column({ name: 'discord_user_id', type: 'varchar', length: 32 })
  discordUserId: string;

  @Column({ type: 'varchar', length: 24, default: 'waiting_server' })
  status: PendingInstallStatus;

  /** Filled when the new guild is detected. */
  @Column({ name: 'guild_id', type: 'varchar', length: 32, nullable: true })
  guildId: string | null;

  /** Current deploy stage code for the live progress bar. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  progress: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
