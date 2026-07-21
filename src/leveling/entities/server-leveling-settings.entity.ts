import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Per-guild leveling configuration. One row per guild.
 *
 * `levelup_channel_id` semantics:
 *   - real channel id  → post in that channel
 *   - 'dm'             → DM the user
 *   - null / empty     → disabled (no notification)
 */
@Entity('server_leveling_settings')
export class ServerLevelingSettings {
  @PrimaryColumn({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'levelup_channel_id', type: 'varchar', length: 32, nullable: true })
  levelupChannelId: string | null;

  /** Twitch Watch Time XP (TZ-B §2, Premium). */
  @Column({ name: 'watch_xp_enabled', type: 'boolean', default: false })
  watchXpEnabled: boolean;

  @Column({ name: 'watch_xp_per_tick', type: 'int', default: 10 })
  watchXpPerTick: number;

  @Column({ name: 'watch_xp_daily_cap', type: 'int', default: 600 })
  watchXpDailyCap: number;

  @Column({ name: 'levelup_message_template', type: 'text', default: 'GG {user}! You hit level {level}!' })
  levelupMessageTemplate: string;

  @Column({ name: 'notify_only_new_tier', type: 'boolean', default: false })
  notifyOnlyNewTier: boolean;

  // ── Chat XP ──
  @Column({ name: 'chat_xp_enabled', type: 'boolean', default: true })
  chatXpEnabled: boolean;

  @Column({ name: 'chat_xp_min', type: 'int', default: 15 })
  chatXpMin: number;

  @Column({ name: 'chat_xp_max', type: 'int', default: 25 })
  chatXpMax: number;

  @Column({ name: 'chat_xp_cooldown', type: 'int', default: 60 })
  chatXpCooldown: number;

  @Column({ name: 'chat_xp_min_length', type: 'int', default: 10 })
  chatXpMinLength: number;

  // ── Voice XP ──
  @Column({ name: 'voice_xp_enabled', type: 'boolean', default: true })
  voiceXpEnabled: boolean;

  @Column({ name: 'voice_xp_per_minute', type: 'int', default: 10 })
  voiceXpPerMinute: number;

  @Column({ name: 'voice_xp_min_users', type: 'int', default: 2 })
  voiceXpMinUsers: number;

  @Column({ name: 'voice_xp_afk_minutes', type: 'int', default: 15 })
  voiceXpAfkMinutes: number;

  // ── Role rewards ──
  @Column({ name: 'role_rewards_mode', type: 'varchar', length: 16, default: 'stack' })
  roleRewardsMode: 'stack' | 'replace';

  // ── Rank card visuals ──
  @Column({ name: 'rank_bg_image_url', type: 'varchar', length: 1024, nullable: true })
  rankBgImageUrl: string | null;

  @Column({ name: 'rank_bg_color', type: 'varchar', length: 16, default: '#1a1a1a' })
  rankBgColor: string;

  @Column({ name: 'rank_overlay_opacity', type: 'int', default: 40 })
  rankOverlayOpacity: number;

  @Column({ name: 'rank_primary_text_color', type: 'varchar', length: 16, default: '#FFFFFF' })
  rankPrimaryTextColor: string;

  @Column({ name: 'rank_secondary_text_color', type: 'varchar', length: 16, default: '#B0B0B0' })
  rankSecondaryTextColor: string;

  @Column({ name: 'rank_accent_color', type: 'varchar', length: 16, default: '#8b5cf6' })
  rankAccentColor: string;

  @Column({ name: 'rank_progress_color', type: 'varchar', length: 16, default: '#8b5cf6' })
  rankProgressColor: string;

  @Column({ name: 'rank_progress_bg_color', type: 'varchar', length: 32, default: 'rgba(255,255,255,0.2)' })
  rankProgressBgColor: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
