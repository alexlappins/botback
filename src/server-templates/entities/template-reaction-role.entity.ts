import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ServerTemplate } from './server-template.entity';

@Entity('template_reaction_roles')
export class TemplateReactionRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.reactionRoles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  @Column({ name: 'channel_name', length: 128 })
  channelName: string;

  @Column({ name: 'message_order', type: 'int', default: 0 })
  messageOrder: number;

  /** Эмодзи: unicode или id кастомного */
  @Column({ name: 'emoji_key', length: 64 })
  emojiKey: string;

  @Column({ name: 'role_name', length: 128 })
  roleName: string;
}
