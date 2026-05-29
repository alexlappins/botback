import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Default Discord embed customisation surface. Empty / partial objects
 * fall back to per-field defaults at render time.
 */
export interface EmbedConfig {
  /** "#RRGGBB" – embed strip colour. */
  color?: string;
  titleTemplate?: string;
  descriptionTemplate?: string;
  buttonLabel?: string;
  contentTemplate?: string;
  showGame?: boolean;
  showThumbnail?: boolean;
  showStreamerAvatar?: boolean;
}

/** Single platform discriminator + a non-empty identifier on that platform. */
export type StreamPlatform = 'twitch' | 'youtube' | 'kick' | 'tiktok';

/**
 * One tracked streamer for one guild.
 *
 * Polymorphic by `platform`:  twitch | youtube | kick | tiktok.
 * `platform_user_id` is the broadcaster's canonical id on that platform
 * (e.g. Twitch broadcaster id) — EventSub subscribes on the id, not the
 * username, because usernames can change.
 *
 * (guild_id, platform, platform_user_id) is unique so the same streamer
 * can't be added twice to one guild.
 */
@Entity('stream_subscriptions')
@Unique('stream_subs_guild_platform_user_uniq', ['guildId', 'platform', 'platformUserId'])
@Index(['guildId'])
export class StreamSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'discord_channel_id', type: 'varchar', length: 32 })
  discordChannelId: string;

  @Column({ type: 'varchar', length: 16 })
  platform: StreamPlatform;

  @Column({ name: 'platform_user_id', type: 'varchar', length: 64 })
  platformUserId: string;

  @Column({ name: 'platform_username', type: 'varchar', length: 128 })
  platformUsername: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'is_live', type: 'boolean', default: false })
  isLive: boolean;

  @Column({ name: 'current_stream_id', type: 'varchar', length: 64, nullable: true })
  currentStreamId: string | null;

  @Column({ name: 'current_stream_started_at', type: 'timestamp', nullable: true })
  currentStreamStartedAt: Date | null;

  @Column({ name: 'content_template', type: 'text', nullable: true })
  contentTemplate: string | null;

  @Column({ name: 'embed_config', type: 'jsonb', default: () => "'{}'::jsonb" })
  embedConfig: EmbedConfig;

  @Column({ name: 'last_notified_at', type: 'timestamp', nullable: true })
  lastNotifiedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
