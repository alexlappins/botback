import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

@Entity('template_stickers')
export class TemplateSticker {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.stickers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Имя стикера (2-30 символов) */
  @Column({ length: 30 })
  name: string;

  /** Описание стикера (необязательно, до 100 символов) */
  @Column({ type: 'varchar', length: 100, nullable: true })
  description: string | null;

  /** Связанный тег-эмодзи (Unicode, например 😀) */
  @Column({ length: 32 })
  tags: string;

  /** URL загруженного файла (PNG/APNG, ≤512 КБ, 320×320) */
  @Column({ name: 'image_url', type: 'varchar', length: 512 })
  imageUrl: string;
}
