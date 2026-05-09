import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Records the first time a user joined a given guild while the bot was watching.
 * Used to detect "returning" members for welcome customization.
 */
@Entity('guild_members_seen')
@Index(['guildId', 'userId'], { unique: true })
export class GuildMemberSeen {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', length: 32 })
  guildId: string;

  @Column({ name: 'user_id', length: 32 })
  userId: string;

  @CreateDateColumn({ name: 'first_seen_at' })
  firstSeenAt: Date;
}
