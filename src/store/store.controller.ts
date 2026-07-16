import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import type { ProductStatus, StoreCategory } from './entities/store-template.entity';
import { InstallFlowService } from './install-flow.service';
import { StoreService, type StoreSort } from './store.service';

const VALID_SORTS: StoreSort[] = ['newest', 'popular', 'price_asc', 'price_desc'];
const VALID_CATEGORIES: StoreCategory[] = [
  'streamer',
  'vtuber',
  'gaming',
  'community',
  'anime',
  'crypto',
  'streaming',
  'other',
];
const VALID_STATUSES: ProductStatus[] = ['draft', 'published', 'archived'];

@Controller('api/store')
export class StoreController {
  constructor(
    private readonly store: StoreService,
    private readonly installFlow: InstallFlowService,
  ) {}

  @Get('templates')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  listTemplates(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('tags') tagsRaw?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const cat = VALID_CATEGORIES.includes(category as StoreCategory)
      ? (category as StoreCategory)
      : undefined;
    const sortKey = VALID_SORTS.includes(sort as StoreSort) ? (sort as StoreSort) : 'newest';
    const tags = tagsRaw
      ? tagsRaw
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    return this.store.listPublicTemplates({
      q,
      category: cat,
      tags,
      sort: sortKey,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('templates/featured')
  @Header('Cache-Control', 'no-store')
  featured() {
    return this.store.listFeatured();
  }

  @Get('templates/facets')
  @Header('Cache-Control', 'no-store')
  facets() {
    return this.store.listFacets();
  }

  /** Product page payload — `key` is the slug (or legacy row id). */
  @Get('templates/:key')
  @Header('Cache-Control', 'no-store')
  getOne(@Param('key') key: string) {
    return this.store.getBySlugOrId(key);
  }

  /** Buy click → Stripe Checkout URL (TZ-1 §4.1). */
  @Post('checkout')
  @UseGuards(SessionGuard, CustomerGuard)
  checkout(@Req() req: Request, @Body() body: { productId?: string; templateId?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    const key = body?.productId?.trim() || body?.templateId?.trim();
    if (!key) throw new BadRequestException('productId required');
    return this.store.checkout(user.id, key);
  }

  @Get('my-purchases')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  myPurchases(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    return this.store.myPurchases(user.id);
  }

  // ── Install flow (TZ-2) ─────────────────────────────────

  @Post('installs')
  @UseGuards(SessionGuard, CustomerGuard)
  startInstall(@Req() req: Request, @Body() body: { purchaseId?: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    if (!body?.purchaseId) throw new BadRequestException('purchaseId required');
    return this.installFlow.start(body.purchaseId, user.id);
  }

  @Get('installs/:id')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store')
  installStatus(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    return this.installFlow.getStatus(id, user.id);
  }

  /** Manual "I've added the bot — start installation" trigger. */
  @Post('installs/:id/trigger')
  @UseGuards(SessionGuard, CustomerGuard)
  installTrigger(@Req() req: Request, @Param('id') id: string) {
    const user = (req as Request & { user: SessionUser }).user;
    return this.installFlow.trigger(id, user.id);
  }
}

@Controller('api/admin/store')
@UseGuards(SessionGuard, AdminGuard)
export class AdminStoreController {
  constructor(private readonly store: StoreService) {}

  @Get('templates')
  @Header('Cache-Control', 'no-store')
  list() {
    return this.store.listAllForAdmin();
  }

  @Post('templates/upsert')
  upsertTemplate(
    @Body()
    body: {
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
    },
  ) {
    if (body.category !== undefined && body.category !== null && !VALID_CATEGORIES.includes(body.category)) {
      throw new BadRequestException(`category must be one of ${VALID_CATEGORIES.join(', ')}`);
    }
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
      throw new BadRequestException(`status must be one of ${VALID_STATUSES.join(', ')}`);
    }
    return this.store.upsertStoreTemplate(body);
  }

  /** Orders tab (TZ-1 §6.3). */
  @Get('orders')
  @Header('Cache-Control', 'no-store')
  orders() {
    return this.store.listOrders();
  }

  @Post('orders/:id/refund')
  refund(@Param('id') id: string) {
    return this.store.refundPurchase(id);
  }
}
