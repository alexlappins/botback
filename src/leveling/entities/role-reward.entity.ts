import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('role_rewards')
@Index('role_rewards_server_idx', ['serverId'])
@Unique('role_rewards_server_level_uniq', ['serverId', 'level'])
export class RoleReward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ type: 'int' })
  level: number;

  @Column({ name: 'role_id', type: 'varchar', length: 32 })
  roleId: string;

  /** 'level' (classic) | 'watch_hours' (TZ-B §2.5: N hours watched → role). */
  @Column({ name: 'condition_type', type: 'varchar', length: 16, default: 'level' })
  conditionType: 'level' | 'watch_hours';

  /** Threshold in hours for conditionType='watch_hours'. */
  @Column({ name: 'watch_hours', type: 'int', nullable: true })
  watchHours: number | null;
}
