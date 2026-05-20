import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('no_xp_channels')
@Index('no_xp_channels_server_idx', ['serverId'])
@Unique('no_xp_channels_uniq', ['serverId', 'channelId'])
export class NoXpChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ name: 'channel_id', type: 'varchar', length: 32 })
  channelId: string;

  /** 'text' = block chat XP in this channel; 'voice' = block voice XP */
  @Column({ name: 'channel_type', type: 'varchar', length: 8 })
  channelType: 'text' | 'voice';
}
