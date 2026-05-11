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

@Entity('template_goodbye_variants')
@Index(['templateId'])
export class TemplateGoodbyeVariant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.goodbyeVariants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

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
}
