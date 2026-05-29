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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AdminGuard } from '../auth/admin.guard';
import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import type { StoreCategory } from './entities/store-template.entity';
import { StoreService, type StoreSort } from './store.service';

const VALID_SORTS: StoreSort[] = ['newest', 'popular', 'price_asc', 'price_desc'];
const VALID_CATEGORIES: StoreCategory[] = [
  'gaming',
  'community',
  'anime',
  'crypto',
  'streaming',
  'other',
];

@Controller('api/store')
export class StoreController {
  constructor(
    private readonly store: StoreService,
    private readonly config: ConfigService,
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

  @Get('templates/:id')
  @Header('Cache-Control', 'no-store')
  getOne(@Param('id') id: string) {
    return this.store.getById(id);
  }

  @Post('checkout')
  @UseGuards(SessionGuard, CustomerGuard)
  checkout(@Req() req: Request, @Body() body: { templateId: string }) {
    const user = (req as Request & { user: SessionUser }).user;
    return this.store.checkout(user.id, body.templateId);
  }

  @Get('my-purchases')
  @UseGuards(SessionGuard, CustomerGuard)
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  myPurchases(@Req() req: Request) {
    const user = (req as Request & { user: SessionUser }).user;
    return this.store.myPurchases(user.id);
  }

  /**
   * Webhook skeleton for payment providers.
   * Expected body:
   * { event: 'payment.succeeded', provider: 'stripe', externalPaymentId, userId, templateId }
   */
  @Post('webhook')
  async webhook(
    @Req() req: Request,
    @Body()
    body: {
      event?: string;
      provider?: string;
      externalPaymentId?: string;
      userId?: string;
      templateId?: string;
    },
  ) {
    const expectedSecret = this.config.get<string>('STORE_WEBHOOK_SECRET', '');
    if (expectedSecret) {
      const provided = (req.headers['x-webhook-secret'] ?? '').toString();
      if (provided !== expectedSecret) throw new UnauthorizedException('Invalid webhook secret');
    }
    if (body.event !== 'payment.succeeded') {
      return { ok: true, ignored: true };
    }
    if (!body.provider || !body.externalPaymentId || !body.userId || !body.templateId) {
      throw new BadRequestException('provider, externalPaymentId, userId, templateId required');
    }
    return this.store.finalizePaidPurchase({
      userId: body.userId,
      templateId: body.templateId,
      provider: body.provider,
      externalPaymentId: body.externalPaymentId,
    });
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
      price?: number;
      currency?: string;
      isActive?: boolean;
      longDescription?: string | null;
      category?: StoreCategory | null;
      tags?: string[];
      screenshots?: string[];
      featured?: boolean;
      featuredOrder?: number;
    },
  ) {
    if (body.category !== undefined && body.category !== null && !VALID_CATEGORIES.includes(body.category)) {
      throw new BadRequestException(`category must be one of ${VALID_CATEGORIES.join(', ')}`);
    }
    return this.store.upsertStoreTemplate(body);
  }
}

