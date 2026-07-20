import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Server structure snapshot (§10.1): categories, channels (name/type/topic/
 * order/permission overwrites), roles (name/color/permissions/order/hoist/
 * mentionable). Messages, members and emojis are deliberately NOT included.
 * Last 7 per guild are kept (§10.2).
 */
@Entity('snapshots')
@Index('snapshots_guild_idx', ['guildId', 'createdAt'])
export class ServerSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'jsonb' })
  data: Record<string, unknown>;

  /** 'auto' | 'manual' */
  @Column({ type: 'varchar', length: 8, default: 'manual' })
  type: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
