import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate, type StoreCategory } from './entities/store-template.entity';

export type StoreSort = 'newest' | 'popular' | 'price_asc' | 'price_desc';

export interface ListStoreOptions {
  q?: string;
  category?: StoreCategory;
  tags?: string[];
  sort?: StoreSort;
  limit?: number;
  offset?: number;
}

@Injectable()
export class StoreService {
  constructor(
    @InjectRepository(StoreTemplate)
    private readonly storeTemplateRepo: Repository<StoreTemplate>,
    @InjectRepository(ServerTemplate)
    private readonly serverTemplateRepo: Repository<ServerTemplate>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    @InjectRepository(UserTemplateAccess)
    private readonly accessRepo: Repository<UserTemplateAccess>,
  ) {}

  /**
   * Public storefront list. Filters/sort/pagination applied in SQL — keeps the
   * payload small for the grid and lets us add admin-only "hide unfeatured"
   * filters later without a frontend rewrite.
   *
   * `q` does an ILIKE OR across name + short description + tag literals.
   * For our catalogue size (dozens of products) this is fine; if we grow past
   * a few thousand SKUs we'd swap in a `tsvector` column.
   */
  async listPublicTemplates(
    opts: ListStoreOptions = {},
  ): Promise<{ total: number; items: StoreTemplate[] }> {
    const limit = clampInt(opts.limit, 1, 100, 24);
    const offset = Math.max(0, opts.offset ?? 0);

    const qb = this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where('st.isActive = true');

    if (opts.category) {
      qb.andWhere('st.category = :category', { category: opts.category });
    }
    if (opts.tags?.length) {
      // Postgres array overlap: any tag in the input matches.
      qb.andWhere('st.tags && :tags', { tags: opts.tags });
    }
    if (opts.q?.trim()) {
      const needle = `%${opts.q.trim().toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(t.name) ILIKE :q OR LOWER(t.description) ILIKE :q OR EXISTS (SELECT 1 FROM unnest(st.tags) tg WHERE LOWER(tg) ILIKE :q))',
        { q: needle },
      );
    }

    switch (opts.sort ?? 'newest') {
      case 'popular':
        qb.orderBy('st.purchaseCount', 'DESC').addOrderBy('st.createdAt', 'DESC');
        break;
      case 'price_asc':
        qb.orderBy('st.price', 'ASC').addOrderBy('st.createdAt', 'DESC');
        break;
      case 'price_desc':
        qb.orderBy('st.price', 'DESC').addOrderBy('st.createdAt', 'DESC');
        break;
      case 'newest':
      default:
        qb.orderBy('st.createdAt', 'DESC');
    }

    const total = await qb.getCount();
    const items = await qb.limit(limit).offset(offset).getMany();
    return { total, items };
  }

  /** Hero strip on the store homepage. Max 6 — anything more becomes scroll. */
  listFeatured() {
    return this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where('st.isActive = true AND st.featured = true')
      .orderBy('st.featuredOrder', 'ASC')
      .addOrderBy('st.createdAt', 'DESC')
      .limit(6)
      .getMany();
  }

  /**
   * Product detail page payload — full row + parent ServerTemplate with its
   * relations counted so the "What's inside" block can show real numbers
   * (channels, roles, welcome variants etc.) without exposing internals.
   */
  async getById(storeTemplateId: string) {
    const st = await this.storeTemplateRepo.findOne({
      where: { id: storeTemplateId, isActive: true },
      relations: { template: true },
    });
    if (!st) throw new NotFoundException('Product not found');

    const inside = await this.serverTemplateRepo.findOne({
      where: { id: st.templateId },
      relations: {
        roles: true,
        categories: true,
        channels: true,
        messages: true,
        reactionRoles: true,
        emojis: true,
        stickers: true,
        welcomeVariants: true,
        goodbyeVariants: true,
      },
      relationLoadStrategy: 'query',
    });

    return {
      product: st,
      contents: inside
        ? {
            roles: inside.roles?.length ?? 0,
            categories: inside.categories?.length ?? 0,
            channels: inside.channels?.length ?? 0,
            messages: inside.messages?.length ?? 0,
            reactionRoles: inside.reactionRoles?.length ?? 0,
            emojis: inside.emojis?.length ?? 0,
            stickers: inside.stickers?.length ?? 0,
            welcomeVariants: inside.welcomeVariants?.length ?? 0,
            goodbyeVariants: inside.goodbyeVariants?.length ?? 0,
            serverStatsEnabled: Boolean(inside.enableServerStats),
            levelingEnabled: Boolean(inside.levelingEnabled),
            welcomeEnabled: Boolean(inside.welcomeEnabled),
            goodbyeEnabled: Boolean(inside.goodbyeEnabled),
          }
        : null,
    };
  }

  /**
   * Filter facets so the storefront chips show only categories/tags that
   * actually have products. Computed on demand — for our catalogue size the
   * extra query is cheaper than maintaining a denormalised summary table.
   */
  async listFacets() {
    const categories = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .select('st.category', 'category')
      .addSelect('COUNT(*)::int', 'count')
      .where('st.isActive = true AND st.category IS NOT NULL')
      .groupBy('st.category')
      .getRawMany<{ category: StoreCategory; count: number }>();

    const tagRows = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .select('tg.tag', 'tag')
      .addSelect('COUNT(*)::int', 'count')
      .from((sub) => sub.from(StoreTemplate, 's').select('unnest(s.tags)', 'tag').where('s.is_active = true'), 'tg')
      .groupBy('tg.tag')
      .orderBy('count', 'DESC')
      .limit(50)
      .getRawMany<{ tag: string; count: number }>();

    return { categories, tags: tagRows };
  }

  async upsertStoreTemplate(input: {
    templateId: string;
    price?: number;
    currency?: string;
    isActive?: boolean;
    longDescription?: string | null;
    category?: StoreCategory | null;
    tags?: string[];
    screenshots?: string[];
    featured?: boolean;
    featuredOrder?: number;
  }) {
    const template = await this.serverTemplateRepo.findOne({ where: { id: input.templateId } });
    if (!template) throw new NotFoundException('Template not found');
    let row = await this.storeTemplateRepo.findOne({ where: { templateId: input.templateId } });
    if (!row) row = this.storeTemplateRepo.create({ templateId: input.templateId });
    if (input.price !== undefined) row.price = input.price;
    if (input.currency !== undefined) row.currency = input.currency;
    if (input.isActive !== undefined) row.isActive = input.isActive;
    if (input.longDescription !== undefined) row.longDescription = input.longDescription;
    if (input.category !== undefined) row.category = input.category;
    if (input.tags !== undefined) row.tags = cleanStringArray(input.tags, 24);
    if (input.screenshots !== undefined) row.screenshots = cleanStringArray(input.screenshots, 12);
    if (input.featured !== undefined) row.featured = input.featured;
    if (input.featuredOrder !== undefined) row.featuredOrder = input.featuredOrder;
    return this.storeTemplateRepo.save(row);
  }

  /** Admin-only: full list for the management table — includes inactive rows. */
  listAllForAdmin() {
    return this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .orderBy('st.featured', 'DESC')
      .addOrderBy('st.featuredOrder', 'ASC')
      .addOrderBy('st.createdAt', 'DESC')
      .getMany();
  }

  async checkout(userId: string, templateId: string) {
    const st = await this.storeTemplateRepo.findOne({ where: { templateId, isActive: true } });
    if (!st) throw new BadRequestException('Template is not available for purchase');

    const purchase = this.purchaseRepo.create({
      userId,
      templateId,
      amount: st.price,
      currency: st.currency,
      status: 'paid',
      provider: 'internal',
      externalPaymentId: null,
    });
    await this.purchaseRepo.save(purchase);

    const existingAccess = await this.accessRepo.findOne({ where: { userId, templateId } });
    if (!existingAccess) {
      await this.accessRepo.save(this.accessRepo.create({ userId, templateId }));
    }

    // Increment popularity counter for the "popular" sort. Done outside the
    // transactional path so a stat-bump failure can't break the purchase.
    await this.storeTemplateRepo.increment({ id: st.id }, 'purchaseCount', 1).catch(() => null);

    return { ok: true, purchaseId: purchase.id };
  }

  async finalizePaidPurchase(input: {
    userId: string;
    templateId: string;
    provider: string;
    externalPaymentId: string;
  }) {
    const st = await this.storeTemplateRepo.findOne({ where: { templateId: input.templateId, isActive: true } });
    if (!st) throw new BadRequestException('Template is not available for purchase');

    const existing = await this.purchaseRepo.findOne({
      where: { externalPaymentId: input.externalPaymentId },
    });
    if (existing) {
      return { ok: true, purchaseId: existing.id, alreadyProcessed: true };
    }

    const purchase = this.purchaseRepo.create({
      userId: input.userId,
      templateId: input.templateId,
      amount: st.price,
      currency: st.currency,
      status: 'paid',
      provider: input.provider,
      externalPaymentId: input.externalPaymentId,
    });
    await this.purchaseRepo.save(purchase);

    const existingAccess = await this.accessRepo.findOne({
      where: { userId: input.userId, templateId: input.templateId },
    });
    if (!existingAccess) {
      await this.accessRepo.save(this.accessRepo.create({ userId: input.userId, templateId: input.templateId }));
    }

    return { ok: true, purchaseId: purchase.id, alreadyProcessed: false };
  }

  myPurchases(userId: string) {
    return this.purchaseRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }
}

// ── Helpers ────────────────────────────────────────────────

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Trim, dedupe, drop empties, cap to `maxItems`. */
function cleanStringArray(input: unknown, maxItems: number): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out.add(t);
    if (out.size >= maxItems) break;
  }
  return [...out];
}

