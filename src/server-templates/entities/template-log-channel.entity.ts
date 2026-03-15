import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { LogChannelsConfig } from '../../common/storage/guild-storage.service';
import { ServerTemplate } from './server-template.entity';

@Entity('template_log_channels')
export class TemplateLogChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id' })
  templateId: string;

  @ManyToOne(() => ServerTemplate, (t) => t.logChannels, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  @Column({ name: 'log_type', type: 'varchar', length: 32 })
  logType: keyof LogChannelsConfig;

  @Column({ name: 'channel_name', length: 128 })
  channelName: string;
}
