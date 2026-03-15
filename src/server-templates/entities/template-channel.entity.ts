import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

/** permission_overwrites: [{ roleName, allow: "0", deny: "0" }] */
export type TemplatePermissionOverwrite = {
  roleName: string;
  allow: string;
  deny: string;
};

@Entity('template_channels')
export class TemplateChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.channels, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Имя категории (null = без категории) */
  @Column({ name: 'category_name', type: 'varchar', length: 128, nullable: true })
  categoryName: string | null;

  @Column({ length: 128 })
  name: string;

  /** 0 text, 2 voice, 4 category, 5 announcement */
  @Column({ type: 'int', default: 0 })
  type: number;

  @Column({ type: 'text', nullable: true })
  topic: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'jsonb', nullable: true })
  permissionOverwrites: TemplatePermissionOverwrite[] | null;
}
