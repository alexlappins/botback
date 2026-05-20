import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Template-side mirror of {@link ServerTier}. Owner-admin sets up the tier
 * ladder once; install copies these rows into the buyer's `server_tiers`.
 */
@Entity('template_tiers')
@Index(['templateId'])
export class TemplateTier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid' })
  templateId: string;

  @Column({ type: 'varchar', length: 64 })
  name: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  emoji: string | null;

  @Column({ name: 'icon_url', type: 'varchar', length: 1024, nullable: true })
  iconUrl: string | null;

  @Column({ name: 'start_level', type: 'int' })
  startLevel: number;

  @Column({ name: 'end_level', type: 'int' })
  endLevel: number;

  @Column({ type: 'varchar', length: 16, default: '#8b5cf6' })
  color: string;

  @Column({ name: 'levelup_message', type: 'text', nullable: true })
  levelupMessage: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;
}
