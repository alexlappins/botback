import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { WelcomeTemplate } from './welcome-template.entity';

/**
 * Per-guild Welcome configuration. Delivery-level settings only:
 * where to send, whether the returning-member pool is active. The actual
 * message content (text, image, buttons) lives per-variant on WelcomeTemplate.
 */
@Entity('welcome_configs')
@Index(['guildId'], { unique: true })
export class WelcomeConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  /** 'channel' = post to channel, 'dm' = direct message the user */
  @Column({ name: 'send_mode', type: 'varchar', length: 16, default: 'channel' })
  sendMode: 'channel' | 'dm';

  @Column({ name: 'channel_id', type: 'varchar', length: 32, nullable: true })
  channelId: string | null;

  /** When true, the listener uses returning_member variants for users seen before. */
  @Column({ name: 'returning_member_enabled', type: 'boolean', default: false })
  returningMemberEnabled: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => WelcomeTemplate, (t) => t.config, { cascade: true })
  @JoinColumn()
  templates: WelcomeTemplate[];
}
