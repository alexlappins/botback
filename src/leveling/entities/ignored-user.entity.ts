import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('ignored_users')
@Index('ignored_users_server_idx', ['serverId'])
@Unique('ignored_users_uniq', ['serverId', 'discordId'])
export class IgnoredUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ name: 'discord_id', type: 'varchar', length: 32 })
  discordId: string;
}
