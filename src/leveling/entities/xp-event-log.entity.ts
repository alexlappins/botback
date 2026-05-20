import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('xp_events_log')
@Index('xp_events_server_created_idx', ['serverId', 'createdAt'])
export class XpEventLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ name: 'discord_id', type: 'varchar', length: 32 })
  discordId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 16 })
  eventType: 'chat' | 'voice' | 'admin_give' | 'admin_remove' | 'admin_set' | 'admin_reset';

  @Column({ name: 'xp_amount', type: 'int' })
  xpAmount: number;

  @Column({ name: 'new_total', type: 'bigint' })
  newTotal: string;

  @Column({ name: 'new_level', type: 'int' })
  newLevel: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
