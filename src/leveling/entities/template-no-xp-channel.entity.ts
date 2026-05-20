import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Template-side mirror of {@link NoXpChannel}. Stored by channel NAME + type. */
@Entity('template_no_xp_channels')
@Unique('template_no_xp_channels_uniq', ['templateId', 'channelName', 'channelType'])
export class TemplateNoXpChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ name: 'channel_name', type: 'varchar', length: 128 })
  channelName: string;

  @Column({ name: 'channel_type', type: 'varchar', length: 8 })
  channelType: 'text' | 'voice';
}
