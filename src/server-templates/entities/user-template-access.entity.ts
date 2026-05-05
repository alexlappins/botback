import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('user_template_access')
@Index(['userId', 'templateId'], { unique: true })
export class UserTemplateAccess {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @CreateDateColumn({ name: 'granted_at' })
  grantedAt: Date;

  /** Timestamp when this access was used to install on a guild. NULL = not yet used. */
  @Column({ name: 'installed_at', type: 'timestamp', nullable: true })
  installedAt: Date | null;

  /** The guild ID where this template was installed (for one-shot products) */
  @Column({ name: 'installed_guild_id', type: 'varchar', length: 32, nullable: true })
  installedGuildId: string | null;

  /**
   * Usage type. For one-shot products an access can be used once;
   * for multi-use it can be installed any number of times.
   * Default 'oneShot' since current product set is one-shot server templates.
   */
  @Column({ name: 'usage_type', type: 'varchar', length: 16, default: 'oneShot' })
  usageType: 'oneShot' | 'multi';

  /** Snapshot of price paid (for purchases history) */
  @Column({ name: 'price_paid', type: 'integer', nullable: true })
  pricePaid: number | null;

  /** Currency at the time of purchase, ISO code (USD, EUR…) */
  @Column({ name: 'currency', type: 'varchar', length: 8, nullable: true })
  currency: string | null;
}

