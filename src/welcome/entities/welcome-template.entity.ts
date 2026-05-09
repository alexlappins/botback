import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { WelcomeConfig } from './welcome-config.entity';

/**
 * One welcome message template variant. A WelcomeConfig may have up to 5;
 * the bot picks one at random per guildMemberAdd (Premium feature).
 * Non-Premium users will only see/use the first one.
 */
@Entity('welcome_templates')
@Index(['configId'])
export class WelcomeTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'config_id', type: 'uuid' })
  configId: string;

  @ManyToOne(() => WelcomeConfig, (c) => c.templates, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'config_id' })
  config: WelcomeConfig;

  @Column({ type: 'text' })
  text: string;

  /** Display order (used for stable list rendering on the dashboard) */
  @Column({ name: 'order_index', type: 'int', default: 0 })
  orderIndex: number;
}
