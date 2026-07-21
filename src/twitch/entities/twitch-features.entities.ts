import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** TZ-A §1.2 — a streamer's Twitch account connected to a guild. */
@Entity('twitch_connections')
@Index('twitch_connections_guild_idx', ['guildId'])
export class TwitchConnection {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'discord_user_id', type: 'varchar', length: 32 })
  discordUserId: string;

  @Column({ name: 'twitch_user_id', type: 'varchar', length: 32 })
  twitchUserId: string;

  @Column({ name: 'twitch_login', type: 'varchar', length: 64 })
  twitchLogin: string;

  /** AES-256-GCM encrypted (TWITCH_TOKEN_KEY env). */
  @Column({ name: 'access_token_enc', type: 'text' })
  accessTokenEnc: string;

  @Column({ name: 'refresh_token_enc', type: 'text' })
  refreshTokenEnc: string;

  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  scopes: string[];

  /** active | revoked | expired */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** TZ-A §2 — one Live Role configuration (Premium: up to 5). */
@Entity('live_role_configs')
@Index('live_role_configs_guild_idx', ['guildId'])
export class LiveRoleConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'role_id', type: 'varchar', length: 32 })
  roleId: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Premium filter: only assign when game/title contains this string. */
  @Column({ name: 'filter_text', type: 'varchar', length: 128, nullable: true })
  filterText: string | null;

  /** Premium: members never given this live role. */
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  blacklist: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** TZ-A §2.2 — Discord member ↔ Twitch channel binding inside a config. */
@Entity('live_role_bindings')
@Index('live_role_bindings_guild_idx', ['guildId'])
@Index('live_role_bindings_twitch_idx', ['twitchUserId'])
export class LiveRoleBinding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'config_id', type: 'uuid' })
  configId: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'discord_user_id', type: 'varchar', length: 32 })
  discordUserId: string;

  @Column({ name: 'twitch_user_id', type: 'varchar', length: 32 })
  twitchUserId: string;

  @Column({ name: 'twitch_login', type: 'varchar', length: 64 })
  twitchLogin: string;

  /** 'auto' (from twitch_connections) | 'manual' */
  @Column({ type: 'varchar', length: 8, default: 'manual' })
  source: string;

  /** Runtime flag mirrored into DB so restarts can reconcile (§2.3). */
  @Column({ name: 'is_live', type: 'boolean', default: false })
  isLive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

export type AlertEventType =
  | 'follow'
  | 'sub'
  | 'resub'
  | 'gift'
  | 'bits'
  | 'raid'
  | 'hype_train';

/** TZ-A §3.2 — per-event alert configuration for a connection's guild. */
@Entity('event_alert_settings')
@Index('event_alert_settings_guild_idx', ['guildId'])
export class EventAlertSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 16 })
  eventType: AlertEventType;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'channel_id', type: 'varchar', length: 32, nullable: true })
  channelId: string | null;

  /** 'text' | 'embed' | 'card' (embed+card are Premium, §3.3). */
  @Column({ type: 'varchar', length: 8, default: 'text' })
  format: string;

  /** Template with {user} {amount} {tier} {message} {streamer} {months} {viewers}. */
  @Column({ type: 'text', nullable: true })
  template: string | null;

  /** Image Card config: {backgroundUrl, textColor, font} (§3.4). */
  @Column({ name: 'card_config', type: 'jsonb', nullable: true })
  cardConfig: Record<string, unknown> | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** TZ-B §2.2 — GLOBAL viewer link (not per-guild). */
@Entity('viewer_links')
export class ViewerLink {
  @PrimaryColumn({ name: 'discord_user_id', type: 'varchar', length: 32 })
  discordUserId: string;

  @Column({ name: 'twitch_user_id', type: 'varchar', length: 32 })
  @Index('viewer_links_twitch_idx')
  twitchUserId: string;

  @Column({ name: 'twitch_login', type: 'varchar', length: 64 })
  twitchLogin: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** TZ-B §1 — Schedule Sync settings per guild. */
@Entity('schedule_sync_settings')
export class ScheduleSyncSettings {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** stream_subscription ids to sync; empty = all tracked channels. */
  @Column({ name: 'source_subs', type: 'text', array: true, default: () => "'{}'::text[]" })
  sourceSubs: string[];

  @Column({ name: 'title_template', type: 'varchar', length: 200, nullable: true })
  titleTemplate: string | null;

  @Column({ name: 'description_template', type: 'text', nullable: true })
  descriptionTemplate: string | null;

  @Column({ name: 'cover_url', type: 'text', nullable: true })
  coverUrl: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** TZ-B §1.3 — twitch segment ↔ discord scheduled event mapping (no dupes). */
@Entity('schedule_sync_map')
@Index('schedule_sync_map_guild_idx', ['guildId'])
export class ScheduleSyncMapEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'segment_id', type: 'varchar', length: 128 })
  segmentId: string;

  @Column({ name: 'discord_event_id', type: 'varchar', length: 32 })
  discordEventId: string;

  /** Hash of (start,title,category) to detect segment edits cheaply. */
  @Column({ type: 'varchar', length: 64 })
  fingerprint: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
