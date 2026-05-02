import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Per-guild snapshot of a reaction-role binding after install.
 * Stores real Discord IDs (channel/message/role).
 */
@Entity('guild_reaction_roles')
@Index(['guildId'])
@Index(['guildId', 'discordMessageId', 'emojiKey'], { unique: true })
export class GuildReactionRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', length: 32 })
  guildId: string;

  @Column({ name: 'discord_channel_id', length: 32 })
  discordChannelId: string;

  @Column({ name: 'discord_message_id', length: 32 })
  discordMessageId: string;

  /** Unicode emoji or custom emoji ID */
  @Column({ name: 'emoji_key', length: 64 })
  emojiKey: string;

  @Column({ name: 'discord_role_id', length: 32 })
  discordRoleId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
