import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TemplateCategory } from './template-category.entity';
import { TemplateChannel } from './template-channel.entity';
import { TemplateLogChannel } from './template-log-channel.entity';
import { TemplateMessage } from './template-message.entity';
import { TemplateReactionRole } from './template-reaction-role.entity';
import { TemplateRole } from './template-role.entity';

@Entity('server_templates')
export class ServerTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => TemplateRole, (r) => r.template)
  roles: TemplateRole[];

  @OneToMany(() => TemplateCategory, (c) => c.template)
  categories: TemplateCategory[];

  @OneToMany(() => TemplateChannel, (c) => c.template)
  channels: TemplateChannel[];

  @OneToMany(() => TemplateMessage, (m) => m.template)
  messages: TemplateMessage[];

  @OneToMany(() => TemplateReactionRole, (r) => r.template)
  reactionRoles: TemplateReactionRole[];

  @OneToMany(() => TemplateLogChannel, (l) => l.template)
  logChannels: TemplateLogChannel[];
}
