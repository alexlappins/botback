import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

/**
 * Привязка категории шаблона к роли по названию.
 * При деплое бот возьмёт первую роль из шаблона + название категории отсюда,
 * найдёт реальные ID на гильдии и выставит для роли разрешение читать/писать в этих категориях.
 * Категории которых нет в этом списке бот не трогает.
 */
@Entity('template_category_grants')
@Unique(['templateId', 'categoryName'])
export class TemplateCategoryGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.categoryGrants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Имя категории шаблона (как в TemplateCategory.name) */
  @Column({ name: 'category_name', length: 128 })
  categoryName: string;
}
