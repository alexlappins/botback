import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { GoodbyeTemplate } from './goodbye-template.entity';

/**
 * Per-guild Goodbye configuration. Delivery-level settings only;
 * full message bodies live per-variant on GoodbyeTemplate.
 */
@Entity('goodbye_configs')
@Index(['guildId'], { unique: true })
export class GoodbyeConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guild_id', type: 'varchar', length: 32 })
  guildId: string;

  @Column({ type: 'boolean', default: false })
  enabled: boolean;

  @Column({ name: 'channel_id', type: 'varchar', length: 32, nullable: true })
  channelId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => GoodbyeTemplate, (t) => t.config, { cascade: true })
  @JoinColumn()
  templates: GoodbyeTemplate[];
}
