import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { GoodbyeConfig } from './goodbye-config.entity';

/**
 * One goodbye message template variant. A GoodbyeConfig may have up to 5;
 * the bot picks one at random per guildMemberRemove (Premium feature).
 * Non-Premium users will only see/use the first one.
 */
@Entity('goodbye_templates')
@Index(['configId'])
export class GoodbyeTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'config_id' })
  configId: string;

  @ManyToOne(() => GoodbyeConfig, (c) => c.templates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'config_id' })
  config: GoodbyeConfig;

  @Column({ type: 'text' })
  text: string;

  /** Display order (used for stable list rendering on the dashboard) */
  @Column({ name: 'order_index', type: 'int', default: 0 })
  orderIndex: number;
}
