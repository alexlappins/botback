import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ServerTemplate } from '../../server-templates/entities/server-template.entity';

/** Top-level shelf for the storefront filter chips. Add freely as catalogue grows. */
export type StoreCategory =
  | 'gaming'
  | 'community'
  | 'anime'
  | 'crypto'
  | 'streaming'
  | 'other';

@Entity('store_templates')
@Index('store_templates_featured_idx', ['featured', 'featuredOrder'], { where: 'featured' })
export class StoreTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'template_id', type: 'uuid', unique: true })
  templateId: string;

  @ManyToOne(() => ServerTemplate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'template_id' })
  template: ServerTemplate;

  @Column({ type: 'int', default: 0 })
  price: number;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /** Markdown. Rendered on the product detail page. */
  @Column({ name: 'long_description', type: 'text', nullable: true })
  longDescription: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  category: StoreCategory | null;

  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  tags: string[];

  /** Ordered list of preview screenshots (URLs from /api/uploads). */
  @Column({ type: 'text', array: true, default: () => "'{}'::text[]" })
  screenshots: string[];

  @Column({ type: 'boolean', default: false })
  featured: boolean;

  @Column({ name: 'featured_order', type: 'int', default: 0 })
  featuredOrder: number;

  /** Cheap proxy for "Popular" sort. Bumped on each successful checkout. */
  @Column({ name: 'purchase_count', type: 'int', default: 0 })
  purchaseCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

