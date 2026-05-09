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
import { GoodbyeTemplate } from './goodbye-template.entity';
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from '../image-config.types';

/**
 * Per-guild Goodbye configuration.
 * Channel only (no DM since the user already left).
 */
@Entity('goodbye_configs')
@Index(['guildId'], { unique: true })
export class GoodbyeConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', length: 32 })
  guildId: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({ name: 'channel_id', length: 32, nullable: true })
  channelId: string | null;

  // ── Premium image fields (Iteration 2 — wired but unused) ──
  @Column({ name: 'image_enabled', default: false })
  imageEnabled: boolean;

  @Column({ name: 'image_send_mode', length: 16, default: 'with_text' })
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

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => GoodbyeTemplate, (t) => t.config, { cascade: true })
  @JoinColumn()
  templates: GoodbyeTemplate[];
}
