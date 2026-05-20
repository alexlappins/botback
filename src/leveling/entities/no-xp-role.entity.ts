import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('no_xp_roles')
@Index('no_xp_roles_server_idx', ['serverId'])
@Unique('no_xp_roles_uniq', ['serverId', 'roleId'])
export class NoXpRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ name: 'role_id', type: 'varchar', length: 32 })
  roleId: string;
}
