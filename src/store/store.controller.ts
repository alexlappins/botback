import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
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
import { StoreService } from './store.service';

@Controller('api/store')
export class StoreController {
  constructor(
    private readonly store: StoreService,
    private readonly config: ConfigService,
  ) {}

  @Get('templates')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  @Header('Pragma', 'no-cache')
  listTemplates() {
    return this.store.listPublicTemplates();
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

  @Post('templates/upsert')
  upsertTemplate(
    @Body()
    body: { templateId: string; price?: number; currency?: string; isActive?: boolean },
  ) {
    return this.store.upsertStoreTemplate(body);
  }
}

