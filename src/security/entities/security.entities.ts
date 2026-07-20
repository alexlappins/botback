import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AgeFilterAction = 'alert' | 'quarantine' | 'kick';
export type AntiRaidAction = 'alert' | 'quarantine' | 'kick' | 'ban';
export type AntiNukeAction = 'alert' | 'strip' | 'strip_quarantine';
export type SecurityPreset = 'relaxed' | 'standard' | 'strict';

/** Per-guild Security Suite settings (Security TZ). One row per guild. */
@Entity('security_settings')
export class SecuritySettings {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  /** Last applied preset; null = custom. Purely informational (§9). */
  @Column({ type: 'varchar', length: 16, nullable: true })
  preset: SecurityPreset | null;

  // ── §2 Age Filter (Free) ──
  @Column({ name: 'age_filter_enabled', type: 'boolean', default: false })
  ageFilterEnabled: boolean;
  @Column({ name: 'age_filter_min_days', type: 'int', default: 7 })
  ageFilterMinDays: number;
  @Column({ name: 'age_filter_action', type: 'varchar', length: 16, default: 'alert' })
  ageFilterAction: AgeFilterAction;
  @Column({ name: 'age_filter_kick_message', type: 'text', nullable: true })
  ageFilterKickMessage: string | null;

  // ── §3 Panic Mode (Free) ──
  @Column({ name: 'panic_slowmode_enabled', type: 'boolean', default: false })
  panicSlowmodeEnabled: boolean;
  @Column({ name: 'panic_slowmode_seconds', type: 'int', default: 30 })
  panicSlowmodeSeconds: number;
  @Column({ name: 'panel_channel_id', type: 'varchar', length: 32, nullable: true })
  panelChannelId: string | null;
  @Column({ name: 'panel_message_id', type: 'varchar', length: 32, nullable: true })
  panelMessageId: string | null;

  // ── §4 Anti-Raid (Premium) ──
  @Column({ name: 'anti_raid_action', type: 'varchar', length: 16, default: 'alert' })
  antiRaidAction: AntiRaidAction;
  @Column({ name: 'anti_raid_auto_panic', type: 'boolean', default: false })
  antiRaidAutoPanic: boolean;

  // ── §5 Anti-Nuke (Premium) ──
  @Column({ name: 'anti_nuke_action', type: 'varchar', length: 16, default: 'alert' })
  antiNukeAction: AntiNukeAction;

  // ── §6 Quarantine (Premium) ──
  @Column({ name: 'quarantine_role_id', type: 'varchar', length: 32, nullable: true })
  quarantineRoleId: string | null;
  @Column({ name: 'quarantine_channel_id', type: 'varchar', length: 32, nullable: true })
  quarantineChannelId: string | null;

  // ── §8 Stream Shield (Premium) ──
  @Column({ name: 'shield_enabled', type: 'boolean', default: false })
  shieldEnabled: boolean;
  @Column({ name: 'shield_post_announcements', type: 'boolean', default: true })
  shieldPostAnnouncements: boolean;
  @Column({ name: 'shield_channel_id', type: 'varchar', length: 32, nullable: true })
  shieldChannelId: string | null;
  /** Twitch subscription ids that trigger the shield; empty = all (§8.4). */
  @Column({ name: 'shield_trigger_subs', type: 'text', array: true, default: () => "'{}'::text[]" })
  shieldTriggerSubs: string[];
  @Column({ name: 'shield_slowmode_enabled', type: 'boolean', default: false })
  shieldSlowmodeEnabled: boolean;
  @Column({ name: 'shield_slowmode_seconds', type: 'int', default: 10 })
  shieldSlowmodeSeconds: number;
  @Column({ name: 'shield_slowmode_channels', type: 'text', array: true, default: () => "'{}'::text[]" })
  shieldSlowmodeChannels: string[];
  @Column({ name: 'shield_age_filter_enabled', type: 'boolean', default: false })
  shieldAgeFilterEnabled: boolean;
  @Column({ name: 'shield_age_filter_days', type: 'int', default: 14 })
  shieldAgeFilterDays: number;
  /** {title, description, color, imageUrl} for activation/deactivation (§8.3). */
  @Column({ name: 'shield_embed_on', type: 'jsonb', nullable: true })
  shieldEmbedOn: Record<string, unknown> | null;
  @Column({ name: 'shield_embed_off', type: 'jsonb', nullable: true })
  shieldEmbedOff: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** §1.3 — trusted users/roles. The owner is implicit and never stored. */
@Entity('security_whitelist')
@Index('security_whitelist_guild_idx', ['guildId'])
export class SecurityWhitelistEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'entity_type', type: 'varchar', length: 8 })
  entityType: 'user' | 'role';

  @Column({ name: 'entity_id', type: 'varchar', length: 32 })
  entityId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** §3.2 — pre-panic server state, restored verbatim on deactivation. */
@Entity('panic_state')
export class PanicState {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  /** { verificationLevel, invitesDisabled, slowmodes: {channelId: seconds} } */
  @Column({ name: 'saved_state', type: 'jsonb' })
  savedState: Record<string, unknown>;

  @Column({ name: 'activated_by', type: 'varchar', length: 32 })
  activatedBy: string;

  @CreateDateColumn({ name: 'activated_at' })
  activatedAt: Date;
}

/** §6.2 — a member's stay in quarantine, with their original roles. */
@Entity('quarantine_records')
@Index('quarantine_records_guild_user_idx', ['guildId', 'userId'])
export class QuarantineRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 32 })
  userId: string;

  @Column({ name: 'original_role_ids', type: 'text', array: true, default: () => "'{}'::text[]" })
  originalRoleIds: string[];

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  /** 'auto_raid' | 'auto_nuke' | 'age_filter' | 'manual' | 'alert_button' */
  @Column({ type: 'varchar', length: 24, default: 'manual' })
  source: string;

  /** active | approved | kicked | banned */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string;

  @Column({ name: 'review_message_id', type: 'varchar', length: 32, nullable: true })
  reviewMessageId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** §5.2 — roles stripped by anti-nuke, for one-click restore. */
@Entity('nuke_incidents')
@Index('nuke_incidents_guild_idx', ['guildId', 'createdAt'])
export class NukeIncident {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ name: 'user_id', type: 'varchar', length: 32 })
  userId: string;

  @Column({ name: 'stripped_role_ids', type: 'text', array: true, default: () => "'{}'::text[]" })
  strippedRoleIds: string[];

  @Column({ type: 'varchar', length: 8 })
  detector: string;

  @Column({ type: 'boolean', default: false })
  restored: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
