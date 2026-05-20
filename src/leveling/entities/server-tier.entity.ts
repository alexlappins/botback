import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('server_tiers')
@Index('server_tiers_server_idx', ['serverId'])
export class ServerTier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  emoji: string | null;

  @Column({ name: 'icon_url', type: 'varchar', length: 1024, nullable: true })
  iconUrl: string | null;

  @Column({ name: 'start_level', type: 'int' })
  startLevel: number;

  /** Inclusive end level. Use a large number (e.g. 9999) for the top tier. */
  @Column({ name: 'end_level', type: 'int' })
  endLevel: number;

  @Column({ type: 'varchar', length: 16, default: '#8b5cf6' })
  color: string;

  /** Optional custom message used on tier promotion (placeholders allowed). */
  @Column({ name: 'levelup_message', type: 'text', nullable: true })
  levelupMessage: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
