import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Per-guild custom bot identity (TZ v2.1 §8). Applied to webhook-based sends
 * only when the guild is premium AND enabled=true; the row itself always
 * persists so expiry never loses the customer's setup.
 */
@Entity('bot_personalization')
export class BotPersonalization {
  @PrimaryColumn({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** 2–32 chars, Discord webhook username limit. */
  @Column({ name: 'custom_name', type: 'varchar', length: 32, nullable: true })
  customName: string | null;

  @Column({ name: 'custom_avatar_url', type: 'text', nullable: true })
  customAvatarUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
