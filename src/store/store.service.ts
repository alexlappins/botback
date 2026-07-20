import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Client, TextChannel } from 'discord.js';
import type Stripe from 'stripe';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';
import { StripeService } from '../premium/stripe.service';
import { Purchase } from './entities/purchase.entity';
import { StoreTemplate, type ProductStatus, type StoreCategory } from './entities/store-template.entity';

export type StoreSort = 'newest' | 'price_asc' | 'price_desc' | 'popular';

export interface ListStoreOptions {
  q?: string;
  category?: StoreCategory;
  tags?: string[];
  sort?: StoreSort;
  limit?: number;
  offset?: number;
}

/** Wire shape of a product for the public storefront. */
export interface PublicProduct {
  id: string;
  slug: string;
  name: string;
  price: number;
  oldPrice: number | null;
  currency: string;
  shortDescription: string | null;
  longDescription: string | null;
  category: StoreCategory | null;
  tags: string[];
  coverImageUrl: string | null;
  screenshots: string[];
  createdAt: Date;
}

@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    @InjectRepository(StoreTemplate)
    private readonly storeTemplateRepo: Repository<StoreTemplate>,
    @InjectRepository(ServerTemplate)
    private readonly serverTemplateRepo: Repository<ServerTemplate>,
    @InjectRepository(Purchase)
    private readonly purchaseRepo: Repository<Purchase>,
    @InjectRepository(UserTemplateAccess)
    private readonly accessRepo: Repository<UserTemplateAccess>,
    private readonly stripeService: StripeService,
    private readonly config: ConfigService,
    @Inject(Client) private readonly client: Client,
  ) {}

  /** DB row → public wire shape (name/cover fallbacks resolved here). */
  private toPublic(st: StoreTemplate): PublicProduct {
    return {
      id: st.id,
      slug: st.slug ?? st.id,
      name: st.name ?? st.template?.name ?? 'Untitled',
      price: st.price,
      oldPrice: st.oldPrice,
      currency: st.currency,
      shortDescription: st.shortDescription,
      longDescription: st.longDescription,
      category: st.category,
      tags: st.tags,
      coverImageUrl: st.coverImageUrl ?? st.screenshots[0] ?? st.template?.iconUrl ?? null,
      screenshots: st.screenshots,
      createdAt: st.createdAt,
    };
  }

  /**
   * Public storefront list — published products only (drafts/archived are
   * invisible both here and by direct URL, TZ-1 §7).
   */
  async listPublicTemplates(
    opts: ListStoreOptions = {},
  ): Promise<{ total: number; items: PublicProduct[] }> {
    const limit = clampInt(opts.limit, 1, 100, 24);
    const offset = Math.max(0, opts.offset ?? 0);

    const qb = this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where("st.status = 'published'");

    if (opts.category) {
      qb.andWhere('st.category = :category', { category: opts.category });
    }
    if (opts.tags?.length) {
      qb.andWhere('st.tags && :tags', { tags: opts.tags });
    }
    if (opts.q?.trim()) {
      const needle = `%${opts.q.trim().toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(COALESCE(st.name, t.name)) ILIKE :q OR LOWER(COALESCE(st.short_description, t.description)) ILIKE :q OR EXISTS (SELECT 1 FROM unnest(st.tags) tg WHERE LOWER(tg) ILIKE :q))',
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
    return { total, items: items.map((st) => this.toPublic(st)) };
  }

  /** Hero strip on the store homepage. Max 6 — anything more becomes scroll. */
  async listFeatured(): Promise<PublicProduct[]> {
    const rows = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where("st.status = 'published' AND st.featured = true")
      .orderBy('st.featuredOrder', 'ASC')
      .addOrderBy('st.createdAt', 'DESC')
      .limit(6)
      .getMany();
    return rows.map((st) => this.toPublic(st));
  }

  /**
   * Product detail payload for /shop/[slug] — accepts slug or row id, only
   * published products. Includes spec counts and the full structure tree for
   * the "What's inside" block.
   */
  async getBySlugOrId(key: string) {
    const st = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where("st.status = 'published'")
      .andWhere('(st.slug = :key OR st.id::text = :key)', { key })
      .getOne();
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
      product: this.toPublic(st),
      specs: inside
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
      structure: inside
        ? {
            categories: (inside.categories ?? [])
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((cat) => ({
                name: cat.name,
                channels: (inside.channels ?? [])
                  .filter((ch) => ch.categoryName === cat.name)
                  .sort((a, b) => a.position - b.position)
                  .map((ch) => ({ name: ch.name, type: ch.type })),
              })),
            uncategorized: (inside.channels ?? [])
              .filter((ch) => !ch.categoryName)
              .sort((a, b) => a.position - b.position)
              .map((ch) => ({ name: ch.name, type: ch.type })),
            roles: (inside.roles ?? [])
              .slice()
              .sort((a, b) => b.position - a.position)
              .map((r) => ({ name: r.name, color: r.color })),
          }
        : null,
      related: await this.listRelated(st),
    };
  }

  /** "You may also like" — same category first, then newest others. */
  private async listRelated(st: StoreTemplate): Promise<PublicProduct[]> {
    const rows = await this.storeTemplateRepo
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.template', 't')
      .where("r.status = 'published' AND r.id != :id", { id: st.id })
      .orderBy(`CASE WHEN r.category = :cat THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('r.createdAt', 'DESC')
      .setParameter('cat', st.category ?? '')
      .limit(4)
      .getMany();
    return rows.map((r) => this.toPublic(r));
  }

  /** Filter facets — published products only. */
  async listFacets() {
    const categories = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .select('st.category', 'category')
      .addSelect('COUNT(*)::int', 'count')
      .where("st.status = 'published' AND st.category IS NOT NULL")
      .groupBy('st.category')
      .getRawMany<{ category: StoreCategory; count: number }>();

    const tagRows = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .select('tg.tag', 'tag')
      .addSelect('COUNT(*)::int', 'count')
      .from((sub) => sub.from(StoreTemplate, 's').select('unnest(s.tags)', 'tag').where("s.status = 'published'"), 'tg')
      .groupBy('tg.tag')
      .orderBy('count', 'DESC')
      .limit(50)
      .getRawMany<{ tag: string; count: number }>();

    return { categories, tags: tagRows };
  }

  async upsertStoreTemplate(input: {
    templateId: string;
    slug?: string | null;
    name?: string | null;
    price?: number;
    oldPrice?: number | null;
    currency?: string;
    status?: ProductStatus;
    shortDescription?: string | null;
    longDescription?: string | null;
    category?: StoreCategory | null;
    tags?: string[];
    coverImageUrl?: string | null;
    screenshots?: string[];
    featured?: boolean;
    featuredOrder?: number;
  }) {
    const template = await this.serverTemplateRepo.findOne({ where: { id: input.templateId } });
    if (!template) throw new NotFoundException('Template not found');
    let row = await this.storeTemplateRepo.findOne({ where: { templateId: input.templateId } });
    if (!row) row = this.storeTemplateRepo.create({ templateId: input.templateId });

    if (input.slug !== undefined) {
      const slug = slugify(input.slug ?? '');
      if (!slug) throw new BadRequestException('slug must contain letters or digits');
      const clash = await this.storeTemplateRepo.findOne({ where: { slug } });
      if (clash && clash.templateId !== input.templateId) {
        throw new BadRequestException(`Slug "${slug}" is already used by another product`);
      }
      row.slug = slug;
    }
    if (input.name !== undefined) row.name = input.name?.trim() || null;
    if (input.price !== undefined) row.price = input.price;
    if (input.oldPrice !== undefined) row.oldPrice = input.oldPrice;
    if (input.currency !== undefined) row.currency = input.currency;
    if (input.status !== undefined) {
      row.status = input.status;
      row.isActive = input.status === 'published';
    }
    if (input.shortDescription !== undefined) row.shortDescription = input.shortDescription?.trim() || null;
    if (input.longDescription !== undefined) row.longDescription = input.longDescription;
    if (input.category !== undefined) row.category = input.category;
    if (input.tags !== undefined) row.tags = cleanStringArray(input.tags, 24);
    if (input.coverImageUrl !== undefined) row.coverImageUrl = input.coverImageUrl?.trim() || null;
    if (input.screenshots !== undefined) row.screenshots = cleanStringArray(input.screenshots, 20);
    if (input.featured !== undefined) row.featured = input.featured;
    if (input.featuredOrder !== undefined) row.featuredOrder = input.featuredOrder;

    if (!row.slug) {
      // First save without an explicit slug — derive one from the name.
      const base = slugify(row.name ?? template.name) || 'product';
      let candidate = base;
      for (let i = 2; await this.storeTemplateRepo.findOne({ where: { slug: candidate } }); i++) {
        candidate = `${base}-${i}`;
      }
      row.slug = candidate;
    }
    return this.storeTemplateRepo.save(row);
  }

  /** Admin-only: full list incl. drafts/archived + sales counts. */
  async listAllForAdmin() {
    const rows = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .orderBy('st.featured', 'DESC')
      .addOrderBy('st.featuredOrder', 'ASC')
      .addOrderBy('st.createdAt', 'DESC')
      .getMany();
    const sales = await this.purchaseRepo
      .createQueryBuilder('p')
      .select('p.template_id', 'templateId')
      .addSelect("COUNT(*) FILTER (WHERE p.status = 'paid')::int", 'sales')
      .groupBy('p.template_id')
      .getRawMany<{ templateId: string; sales: number }>();
    const salesByTemplate = new Map(sales.map((s) => [s.templateId, s.sales]));
    return rows.map((st) => ({
      ...st,
      salesCount: salesByTemplate.get(st.templateId) ?? 0,
    }));
  }

  /**
   * Buy click (TZ-1 §4.1): returns a Stripe Checkout URL for this product.
   * No cart, no intermediate pages — the frontend redirects straight there.
   */
  async checkout(userId: string, key: string): Promise<{ url: string }> {
    const st = await this.storeTemplateRepo
      .createQueryBuilder('st')
      .innerJoinAndSelect('st.template', 't')
      .where("st.status = 'published'")
      .andWhere('(st.slug = :key OR st.id::text = :key OR st.template_id::text = :key)', { key })
      .getOne();
    if (!st) throw new BadRequestException('Product is not available for purchase');
    if (st.price <= 0) throw new BadRequestException('Product has no valid price');

    const pub = this.toPublic(st);
    const url = await this.stripeService.createProductCheckoutSession({
      productId: st.id,
      templateId: st.templateId,
      slug: pub.slug,
      name: pub.name,
      price: st.price,
      currency: st.currency,
      coverImageUrl: pub.coverImageUrl,
      userId,
    });
    return { url };
  }

  /**
   * Webhook: checkout.session.completed with metadata.type=shop_product
   * (TZ-1 §4.2). Idempotent by payment intent id. Grants template access,
   * records the purchase, bumps the popularity counter and notifies the owner.
   */
  async handleStripeCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const meta = session.metadata ?? {};
    const productId = meta.product_id;
    const userId = meta.discord_user_id;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? session.id);
    if (!productId || !userId) {
      this.logger.warn(`shop_product session ${session.id} missing metadata — skipped`);
      return;
    }

    const existing = await this.purchaseRepo.findOne({ where: { externalPaymentId: paymentIntentId } });
    if (existing) return; // Stripe retry — already processed.

    const st = await this.storeTemplateRepo.findOne({ where: { id: productId }, relations: { template: true } });
    if (!st) {
      this.logger.error(`Paid product ${productId} not found — session ${session.id}`);
      return;
    }

    const purchase = this.purchaseRepo.create({
      userId,
      templateId: st.templateId,
      productId: st.id,
      // amount_total is already cents — same unit as our DB (TZ §3).
      amount: session.amount_total != null ? session.amount_total : st.price,
      currency: (session.currency ?? st.currency).toUpperCase(),
      status: 'paid',
      provider: 'stripe',
      externalPaymentId: paymentIntentId,
    });
    await this.purchaseRepo.save(purchase);

    const existingAccess = await this.accessRepo.findOne({ where: { userId, templateId: st.templateId } });
    if (!existingAccess) {
      await this.accessRepo.save(this.accessRepo.create({ userId, templateId: st.templateId }));
    }
    await this.storeTemplateRepo.increment({ id: st.id }, 'purchaseCount', 1).catch(() => null);

    this.logger.log(`Shop sale: ${st.slug ?? st.id} → user ${userId} (${purchase.amount} ${purchase.currency})`);
    await this.notifySale(purchase, this.toPublic(st)).catch((e) =>
      this.logger.warn(`Sale notification failed: ${(e as Error).message}`),
    );
  }

  /** DM-style sale ping into the owner's private channel (TZ-1 §4.3). */
  private async notifySale(purchase: Purchase, product: PublicProduct): Promise<void> {
    const channelId = this.config.get<string>('SHOP_SALES_CHANNEL_ID');
    if (!channelId) return;
    const channel =
      this.client.channels.cache.get(channelId) ??
      (await this.client.channels.fetch(channelId).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    const user = await this.client.users.fetch(purchase.userId).catch(() => null);
    const buyer = user ? `${user.tag} (${purchase.userId})` : purchase.userId;
    await (channel as TextChannel).send({
      embeds: [
        {
          title: '🛒 New shop sale',
          color: 0x57f287,
          fields: [
            { name: 'Product', value: product.name, inline: true },
            { name: 'Amount', value: `${(purchase.amount / 100).toFixed(2)} ${purchase.currency}`, inline: true },
            { name: 'Buyer', value: buyer, inline: false },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  /** My Purchases rows: purchase + product card data + deploy state. */
  async myPurchases(userId: string) {
    const purchases = await this.purchaseRepo.find({ where: { userId }, order: { createdAt: 'DESC' } });
    if (!purchases.length) return [];
    const templateIds = [...new Set(purchases.map((p) => p.templateId))];
    const products = await this.storeTemplateRepo.find({
      where: templateIds.map((templateId) => ({ templateId })),
      relations: { template: true },
    });
    const byTemplate = new Map(products.map((st) => [st.templateId, st]));
    return purchases.map((p) => {
      const st = byTemplate.get(p.templateId);
      const guild = p.deployedGuildId ? this.client.guilds.cache.get(p.deployedGuildId) : null;
      return {
        id: p.id,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        createdAt: p.createdAt,
        deployedGuildId: p.deployedGuildId,
        deployedGuildName: guild?.name ?? null,
        deployedAt: p.deployedAt,
        product: st
          ? this.toPublic(st)
          : { id: p.templateId, slug: p.templateId, name: 'Removed product', price: p.amount, oldPrice: null, currency: p.currency, shortDescription: null, longDescription: null, category: null, tags: [], coverImageUrl: null, screenshots: [], createdAt: p.createdAt },
      };
    });
  }

  /** Admin Orders tab (TZ-1 §6.3). */
  async listOrders() {
    const purchases = await this.purchaseRepo.find({ order: { createdAt: 'DESC' }, take: 500 });
    const templateIds = [...new Set(purchases.map((p) => p.templateId))];
    const products = templateIds.length
      ? await this.storeTemplateRepo.find({
          where: templateIds.map((templateId) => ({ templateId })),
          relations: { template: true },
        })
      : [];
    const byTemplate = new Map(products.map((st) => [st.templateId, st]));
    return Promise.all(
      purchases.map(async (p) => {
        const st = byTemplate.get(p.templateId);
        const user = await this.client.users.fetch(p.userId).catch(() => null);
        const guild = p.deployedGuildId ? this.client.guilds.cache.get(p.deployedGuildId) : null;
        return {
          id: p.id,
          buyerId: p.userId,
          buyerTag: user?.tag ?? null,
          productName: st ? (st.name ?? st.template?.name ?? 'Untitled') : 'Removed product',
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          provider: p.provider,
          deployedGuildId: p.deployedGuildId,
          deployedGuildName: guild?.name ?? null,
          createdAt: p.createdAt,
        };
      }),
    );
  }

  /**
   * Refund an order (TZ-1 §6.3): Stripe refund + status flip. A deployed
   * server is left untouched per the TZ.
   */
  async refundPurchase(purchaseId: string): Promise<{ ok: true }> {
    const p = await this.purchaseRepo.findOne({ where: { id: purchaseId } });
    if (!p) throw new NotFoundException('Purchase not found');
    if (p.status === 'refunded') throw new BadRequestException('Already refunded');
    if (p.provider === 'stripe' && p.externalPaymentId) {
      await this.stripeService.refundPaymentIntent(p.externalPaymentId);
    }
    p.status = 'refunded';
    await this.purchaseRepo.save(p);
    return { ok: true };
  }

  /** Used by the install flow to validate ownership. */
  getPurchaseForUser(purchaseId: string, userId: string) {
    return this.purchaseRepo.findOne({ where: { id: purchaseId, userId } });
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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
