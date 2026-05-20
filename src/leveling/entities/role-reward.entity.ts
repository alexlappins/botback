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
}
