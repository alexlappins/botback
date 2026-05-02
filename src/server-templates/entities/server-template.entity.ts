import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TemplateCategory } from './template-category.entity';
import { TemplateCategoryGrant } from './template-category-grant.entity';
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

  /** Название категории со статистикой (null = дефолт "📊 Статистика сервера") */
  @Column({ name: 'stats_category_name', type: 'varchar', length: 100, nullable: true })
  statsCategoryName: string | null;

  /** Шаблон имени канала "Всего" — `{count}` заменится на число. null = дефолт */
  @Column({ name: 'stats_total_name', type: 'varchar', length: 100, nullable: true })
  statsTotalName: string | null;

  /** Шаблон имени канала "Люди" */
  @Column({ name: 'stats_humans_name', type: 'varchar', length: 100, nullable: true })
  statsHumansName: string | null;

  /** Шаблон имени канала "Боты" */
  @Column({ name: 'stats_bots_name', type: 'varchar', length: 100, nullable: true })
  statsBotsName: string | null;

  /** Шаблон имени канала "В сети" */
  @Column({ name: 'stats_online_name', type: 'varchar', length: 100, nullable: true })
  statsOnlineName: string | null;

  /**
   * Verification: имя категории, которая будет СКРЫТА от выбранной роли.
   * Привязка по имени, не по Discord ID — работает на любом сервере.
   */
  @Column({ name: 'verified_hide_category_name', type: 'varchar', length: 128, nullable: true })
  verifiedHideCategoryName: string | null;

  /** Verification: имя роли, которой выбранная категория и её каналы будут скрыты */
  @Column({ name: 'verified_hide_role_name', type: 'varchar', length: 128, nullable: true })
  verifiedHideRoleName: string | null;

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

  @OneToMany(() => TemplateCategoryGrant, (g) => g.template)
  categoryGrants: TemplateCategoryGrant[];
}
