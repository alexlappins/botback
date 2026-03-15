import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

@Entity('template_roles')
export class TemplateRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.roles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Логическое имя роли (для привязок в каналах и авторолях) */
  @Column({ length: 128 })
  name: string;

  @Column({ type: 'int', default: 0 })
  color: number;

  /** Битовая маска прав (строка для больших чисел) */
  @Column({ type: 'varchar', length: 32, default: '0' })
  permissions: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'boolean', default: false })
  hoist: boolean;

  @Column({ type: 'boolean', default: false })
  mentionable: boolean;
}
