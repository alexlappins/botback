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
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from '../image-config.types';

/**
 * Per-guild Welcome configuration. Iteration 1 — text only (no images yet).
 * Image fields kept on the entity for forward-compat but unused at runtime.
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

  @Column({ name: 'image_enabled', type: 'boolean', default: false })
  imageEnabled: boolean;

  @Column({ name: 'image_send_mode', type: 'varchar', length: 16, default: 'with_text' })
  imageSendMode: 'with_text' | 'before_text' | 'image_only';

  @Column({ name: 'background_image_url', type: 'varchar', length: 1024, nullable: true })
  backgroundImageUrl: string | null;

  @Column({ name: 'avatar_config', type: 'jsonb', nullable: true })
  avatarConfig: AvatarConfig | null;

  @Column({ name: 'username_config', type: 'jsonb', nullable: true })
  usernameConfig: UsernameConfig | null;

  @Column({ name: 'image_text_config', type: 'jsonb', nullable: true })
  imageTextConfig: ImageTextBlock | null;

  @Column({ name: 'background_fill', type: 'varchar', length: 16, nullable: true })
  backgroundFill: string | null;

  /** [{ label, url, emoji? }] up to 3 link buttons (Premium feature, no gating yet) */
  @Column({ name: 'buttons_config', type: 'jsonb', nullable: true })
  buttonsConfig: { label: string; url: string; emoji?: string | null }[] | null;

  @Column({ name: 'returning_member_enabled', type: 'boolean', default: false })
  returningMemberEnabled: boolean;

  @Column({ name: 'returning_member_text', type: 'text', nullable: true })
  returningMemberText: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => WelcomeTemplate, (t) => t.config, { cascade: true })
  @JoinColumn()
  templates: WelcomeTemplate[];
}
