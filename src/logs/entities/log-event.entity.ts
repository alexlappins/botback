import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Тип лога (категория канала): joinLeave, messages, moderation, channel, banKick */
export type LogEventType =
  | 'joinLeave'
  | 'messages'
  | 'moderation'
  | 'channel'
  | 'banKick';

/** Конкретное событие для отображения в ленте */
export type LogEventKind =
  | 'member_join'
  | 'member_leave'
  | 'member_kick'
  | 'message_delete'
  | 'message_edit'
  | 'channel_create'
  | 'channel_delete'
  | 'ban_add'
  | 'timeout'
  | 'timeout_remove';

@Entity('log_events')
@Index('IDX_log_events_guild_created', ['guildId', 'createdAt'])
export class LogEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id' })
  guildId: string;

  @Column({ type: 'varchar', length: 32 })
  type: LogEventType;

  @Column({ type: 'varchar', length: 32 })
  kind: LogEventKind;

  /** Данные для отображения в дашборде (userId, userTag, reason, content и т.д.) */
  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
