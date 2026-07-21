import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * Per (guild, user) XP record. Composite primary key (server_id, discord_id).
 *
 * Cooldown / AFK timestamps live here so we don't need a separate cache.
 */
@Entity('user_xp')
@Index('user_xp_server_total_idx', ['serverId', 'totalXp'])
@Index('user_xp_server_monthly_idx', ['serverId', 'monthlyXp'])
export class UserXp {
  @PrimaryColumn({ name: 'server_id', type: 'varchar', length: 32 })
  serverId: string;

  @PrimaryColumn({ name: 'discord_id', type: 'varchar', length: 32 })
  discordId: string;

  @Column({ name: 'total_xp', type: 'bigint', default: 0 })
  totalXp: string;

  @Column({ type: 'int', default: 0 })
  level: number;

  @Column({ name: 'current_tier_id', type: 'uuid', nullable: true })
  currentTierId: string | null;

  @Column({ name: 'monthly_xp', type: 'bigint', default: 0 })
  monthlyXp: string;

  @Column({ name: 'last_message_at', type: 'timestamp', nullable: true })
  lastMessageAt: Date | null;

  @Column({ name: 'messages_count', type: 'bigint', default: 0 })
  messagesCount: string;

  @Column({ name: 'voice_minutes', type: 'bigint', default: 0 })
  voiceMinutes: string;

  /** Twitch Watch Time XP (TZ-B §2.4): accumulated minutes watched. */
  @Column({ name: 'watch_minutes', type: 'bigint', default: 0 })
  watchMinutes: string;

  /** Daily watch-XP counter for the anti-abuse cap (resets by date). */
  @Column({ name: 'watch_xp_today', type: 'int', default: 0 })
  watchXpToday: number;

  @Column({ name: 'watch_xp_day', type: 'varchar', length: 10, nullable: true })
  watchXpDay: string | null;

  @Column({ name: 'last_active_at', type: 'timestamp', nullable: true })
  lastActiveAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
