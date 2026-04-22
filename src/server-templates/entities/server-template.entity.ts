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
import { TemplateEmoji } from './template-emoji.entity';
import { TemplateLogChannel } from './template-log-channel.entity';
import { TemplateMessage } from './template-message.entity';
import { TemplateReactionRole } from './template-reaction-role.entity';
import { TemplateRole } from './template-role.entity';
import { TemplateSticker } from './template-sticker.entity';

@Entity('server_templates')
export class ServerTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 128 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Ссылка на шаблон сервера Discord (опционально). Например: https://discord.new/... */
  @Column({ name: 'discord_template_url', type: 'varchar', length: 512, nullable: true })
  discordTemplateUrl: string | null;

  /** URL иконки сервера (опционально). Бот установит её при развёртывании шаблона. */
  @Column({ name: 'icon_url', type: 'varchar', length: 512, nullable: true })
  iconUrl: string | null;

  /** Включить статистику сервера (категория с 4 каналами-счётчиками) при установке шаблона */
  @Column({ name: 'enable_server_stats', type: 'boolean', default: false })
  enableServerStats: boolean;

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

  @OneToMany(() => TemplateEmoji, (e) => e.template)
  emojis: TemplateEmoji[];

  @OneToMany(() => TemplateSticker, (s) => s.template)
  stickers: TemplateSticker[];
}
