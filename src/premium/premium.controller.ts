import { Body, Controller, Get, Param, Post, Put, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';

import { AdminGuard } from '../auth/admin.guard';
import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { PremiumService } from './premium.service';
import { StripeService } from './stripe.service';

@Controller('api/guilds/:guildId/premium')
@UseGuards(SessionGuard, CustomerGuard)
export class PremiumController {
  constructor(
    private readonly premium: PremiumService,
    private readonly guilds: GuildsService,
    private readonly stripe: StripeService,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this server');
    }
  }

  /** Premium status for the dashboard (badge + feature gating). */
  @Get()
  async getStatus(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.premium.getStatus(guildId);
  }

  /** Start a Stripe Checkout for this guild's Premium subscription. */
  @Post('checkout')
  async checkout(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const user = (req as Request & { user: SessionUser }).user;
    const url = await this.stripe.createCheckoutSession(guildId, user.id);
    return { url };
  }

  /** Stripe Customer Portal (cancel / change card) for an active subscription. */
  @Post('portal')
  async portal(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const url = await this.stripe.createPortalSession(guildId);
    return { url };
  }

  /**
   * Manual premium toggle. Admin-only — used for testing the gating and for
   * partner/comp grants before the payment provider is wired. The provider
   * webhook will call PremiumService.setPremium directly, not this endpoint.
   *
   * Body: { active: boolean, until?: ISO-string|null }
   */
  @Put()
  @UseGuards(AdminGuard)
  async setStatus(
    @Param('guildId') guildId: string,
    @Body() body: { active?: boolean; until?: string | null },
  ) {
    const active = Boolean(body?.active);
    let currentPeriodEnd: Date | null | undefined;
    if (body?.until === null) currentPeriodEnd = null;
    else if (typeof body?.until === 'string' && body.until.trim()) {
      const d = new Date(body.until);
      currentPeriodEnd = Number.isNaN(d.getTime()) ? undefined : d;
    }
    return this.premium.setPremium(guildId, active, {
      provider: 'manual',
      ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
    });
  }
}
