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

  @Column({ name: 'last_active_at', type: 'timestamp', nullable: true })
  lastActiveAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
