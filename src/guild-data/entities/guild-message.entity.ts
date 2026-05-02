import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-guild snapshot of a template message after install.
 * Created from TemplateMessage at install time and editable independently.
 * On edit/delete the bot mirrors the change to the actual Discord message.
 */
@Entity('guild_messages')
@Index(['guildId'])
export class GuildMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Discord guild ID this message belongs to */
  @Column({ name: 'guild_id', length: 32 })
  guildId: string;

  /** Discord channel ID where the message lives */
  @Column({ name: 'discord_channel_id', length: 32 })
  discordChannelId: string;

  /** Discord message ID — used to edit the real message in place */
  @Column({ name: 'discord_message_id', length: 32 })
  discordMessageId: string;

  /** Channel name at install time (informational, may drift if user renames) */
  @Column({ name: 'channel_name', length: 128 })
  channelName: string;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  /** Discord embed object, JSONB */
  @Column({ type: 'jsonb', nullable: true })
  embedJson: Record<string, unknown> | null;

  /** Components (action rows + buttons), JSONB */
  @Column({ type: 'jsonb', nullable: true })
  componentsJson: unknown[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
