import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

@Entity('template_emojis')
export class TemplateEmoji {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.emojis, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Имя эмодзи (без двоеточий, латиница + _, 2-32 символа) */
  @Column({ length: 32 })
  name: string;

  /** URL загруженного изображения (PNG/GIF/WebP, ≤256 КБ, 128×128 рекомендуется) */
  @Column({ name: 'image_url', type: 'varchar', length: 512 })
  imageUrl: string;
}
