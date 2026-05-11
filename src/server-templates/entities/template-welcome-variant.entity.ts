import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';
import type {
  AvatarConfig,
  ImageTextBlock,
  UsernameConfig,
} from '../../welcome/image-config.types';
import type { WelcomeVariantRole } from '../../welcome/entities/welcome-template.entity';

/**
 * One welcome message variant attached to a ServerTemplate.
 * Mirrors the per-guild WelcomeTemplate shape so the owner can configure
 * exactly what end-users will see, and the install service can copy it
 * into the buyer's WelcomeConfig + variants 1:1.
 */
@Entity('template_welcome_variants')
@Index(['templateId'])
export class TemplateWelcomeVariant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.welcomeVariants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  @Column({ name: 'role', type: 'varchar', length: 24, default: 'new_member' })
  role: WelcomeVariantRole;

  @Column({ type: 'text' })
  text: string;

  @Column({ name: 'order_index', type: 'int', default: 0 })
  orderIndex: number;

  @Column({ name: 'image_enabled', type: 'boolean', default: false })
  imageEnabled: boolean;

  @Column({ name: 'image_send_mode', type: 'varchar', length: 16, default: 'with_text' })
  imageSendMode: 'with_text' | 'before_text' | 'image_only';

  @Column({ name: 'background_image_url', type: 'varchar', length: 1024, nullable: true })
  backgroundImageUrl: string | null;

  @Column({ name: 'background_fill', type: 'varchar', length: 16, nullable: true })
  backgroundFill: string | null;

  @Column({ name: 'avatar_config', type: 'jsonb', nullable: true })
  avatarConfig: AvatarConfig | null;

  @Column({ name: 'username_config', type: 'jsonb', nullable: true })
  usernameConfig: UsernameConfig | null;

  @Column({ name: 'image_text_config', type: 'jsonb', nullable: true })
  imageTextConfig: ImageTextBlock | null;

  @Column({ name: 'buttons_config', type: 'jsonb', nullable: true })
  buttonsConfig: { label: string; url: string; emoji?: string | null }[] | null;
}
