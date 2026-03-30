import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

/**
 * Сообщение для отправки в канал.
 * components: кнопки; в customId плейсхолдер `{{ИмяРоли}}` заменяется на id роли:
 * `rr/{{Role}}` — переключение; `rr/give/{{Role}}` — только выдать; `rr/take/{{Role}}` — только снять.
 */
@Entity('template_messages')
export class TemplateMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  /** Имя канала (из template_channels) */
  @Column({ name: 'channel_name', length: 128 })
  channelName: string;

  /** Порядок сообщения в канале (если несколько) */
  @Column({ name: 'message_order', type: 'int', default: 0 })
  messageOrder: number;

  @Column({ type: 'text', nullable: true })
  content: string | null;

  /** Эмбед: { title?, description?, color?, image? } */
  @Column({ type: 'jsonb', nullable: true })
  embedJson: Record<string, unknown> | null;

  /** Компоненты (кнопки): customId может содержать "rr/{{RoleName}}" */
  @Column({ type: 'jsonb', nullable: true })
  componentsJson: unknown[] | null;
}
