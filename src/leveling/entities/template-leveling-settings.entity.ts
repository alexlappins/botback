import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Template-side mirror of {@link ServerLevelingSettings}. Owner-admin edits
 * these via the template editor; on auto-deploy the install service copies
 * them into the buyer's `server_leveling_settings` row.
 *
 * `levelup_channel_name` + `levelup_channel_mode` together replace the live
 * `levelupChannelId` semantics:
 *   - mode = 'channel' + name "general" → resolved to that channel's id at install
 *   - mode = 'dm'                       → stored as the literal 'dm' on the buyer's row
 *   - mode = 'disabled'                 → null on the buyer's row (no notifications)
 */
@Entity('template_leveling_settings')
export class TemplateLevelingSettings {
  @PrimaryColumn({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'levelup_channel_name', type: 'varchar', length: 128, nullable: true })
  levelupChannelName: string | null;

  @Column({ name: 'levelup_channel_mode', type: 'varchar', length: 16, default: 'channel' })
  levelupChannelMode: 'channel' | 'dm' | 'disabled';

  @Column({ name: 'levelup_message_template', type: 'text', default: 'GG {user}! You hit level {level}!' })
  levelupMessageTemplate: string;

  @Column({ name: 'notify_only_new_tier', type: 'boolean', default: false })
  notifyOnlyNewTier: boolean;

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

  @Column({ name: 'voice_xp_enabled', type: 'boolean', default: true })
  voiceXpEnabled: boolean;

  @Column({ name: 'voice_xp_per_minute', type: 'int', default: 10 })
  voiceXpPerMinute: number;

  @Column({ name: 'voice_xp_min_users', type: 'int', default: 2 })
  voiceXpMinUsers: number;

  @Column({ name: 'voice_xp_afk_minutes', type: 'int', default: 15 })
  voiceXpAfkMinutes: number;

  @Column({ name: 'role_rewards_mode', type: 'varchar', length: 16, default: 'stack' })
  roleRewardsMode: 'stack' | 'replace';

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
