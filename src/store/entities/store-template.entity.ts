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
  | 'streamer'
  | 'vtuber'
  | 'gaming'
  | 'community'
  | 'anime'
  | 'crypto'
  | 'streaming'
  | 'other';

export type ProductStatus = 'draft' | 'published' | 'archived';

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

  /** URL slug for /shop/[slug]. Unique among products. */
  @Column({ type: 'varchar', length: 128, unique: true, nullable: true })
  slug: string | null;

  /** Display name override; falls back to template.name when null. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  name: string | null;

  @Column({ type: 'int', default: 0 })
  price: number;

  /** Strikethrough price for showing a discount; null = no discount shown. */
  @Column({ name: 'old_price', type: 'int', nullable: true })
  oldPrice: number | null;

  @Column({ type: 'varchar', length: 8, default: 'USD' })
  currency: string;

  /** draft → published → archived (TZ-1 §1). Catalog shows published only. */
  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status: ProductStatus;

  /** Kept for backward compat — mirrors status === 'published'. */
  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  /** 1-2 sentences for the catalog card. */
  @Column({ name: 'short_description', type: 'text', nullable: true })
  shortDescription: string | null;

  /** 16:9 cover for the catalog card; falls back to screenshots[0]. */
  @Column({ name: 'cover_image_url', type: 'text', nullable: true })
  coverImageUrl: string | null;

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

