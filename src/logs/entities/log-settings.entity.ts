import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-guild Server Logs 2.0 settings (TZ §3): 7 presets, each with its own
 * toggle + destination channel, plus a "one channel for everything" mode.
 */
@Entity('log_settings')
export class LogSettings {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'single_channel_mode', type: 'boolean', default: false })
  singleChannelMode: boolean;

  @Column({ name: 'single_channel_id', type: 'varchar', length: 32, nullable: true })
  singleChannelId: string | null;

  @Column({ name: 'ban_enabled', type: 'boolean', default: false })
  banEnabled: boolean;
  @Column({ name: 'ban_channel_id', type: 'varchar', length: 32, nullable: true })
  banChannelId: string | null;

  @Column({ name: 'join_leave_enabled', type: 'boolean', default: false })
  joinLeaveEnabled: boolean;
  @Column({ name: 'join_leave_channel_id', type: 'varchar', length: 32, nullable: true })
  joinLeaveChannelId: string | null;

  @Column({ name: 'messages_enabled', type: 'boolean', default: false })
  messagesEnabled: boolean;
  @Column({ name: 'messages_channel_id', type: 'varchar', length: 32, nullable: true })
  messagesChannelId: string | null;

  @Column({ name: 'moderation_enabled', type: 'boolean', default: false })
  moderationEnabled: boolean;
  @Column({ name: 'moderation_channel_id', type: 'varchar', length: 32, nullable: true })
  moderationChannelId: string | null;

  @Column({ name: 'channel_enabled', type: 'boolean', default: false })
  channelEnabled: boolean;
  @Column({ name: 'channel_channel_id', type: 'varchar', length: 32, nullable: true })
  channelChannelId: string | null;

  @Column({ name: 'server_enabled', type: 'boolean', default: false })
  serverEnabled: boolean;
  @Column({ name: 'server_channel_id', type: 'varchar', length: 32, nullable: true })
  serverChannelId: string | null;

  @Column({ name: 'voice_enabled', type: 'boolean', default: false })
  voiceEnabled: boolean;
  @Column({ name: 'voice_channel_id', type: 'varchar', length: 32, nullable: true })
  voiceChannelId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
