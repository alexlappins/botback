import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { Client, Guild, PermissionFlagsBits } from 'discord.js';

import { AdminGuard } from '../auth/admin.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildSubscription } from './entities/guild-subscription.entity';
import { SubscriptionAuditLog } from './entities/subscription-audit-log.entity';
import { PremiumService } from './premium.service';
import { StripeService } from './stripe.service';

interface GuildHit {
  guildId: string;
  name: string;
  iconUrl: string | null;
  memberCount: number | null;
  /** Present only in user-search results. */
  userRole?: 'owner' | 'admin';
}

/**
 * Owner-admin manual subscription management (Misha's TZ §15).
 *
 * Subscriptions are PER GUILD (§15.1) — granting premium to a person with
 * several servers means one grant per server. Manual grants live in the same
 * guild_subscriptions table as Stripe ones, marked provider='manual' (§15.7);
 * isPremium() treats both identically.
 */
@Controller('api/admin/subscriptions')
@UseGuards(SessionGuard, AdminGuard)
export class AdminSubscriptionsController {
  constructor(
    private readonly premium: PremiumService,
    private readonly stripeService: StripeService,
    @Inject(Client) private readonly client: Client,
    @InjectRepository(GuildSubscription)
    private readonly subRepo: Repository<GuildSubscription>,
    @InjectRepository(SubscriptionAuditLog)
    private readonly auditRepo: Repository<SubscriptionAuditLog>,
  ) {}

  private getAdmin(req: Request): SessionUser {
    return (req as Request & { user: SessionUser }).user;
  }

  private guildToHit(g: Guild): GuildHit {
    return {
      guildId: g.id,
      name: g.name,
      iconUrl: g.iconURL({ size: 64 }),
      memberCount: g.memberCount ?? null,
    };
  }

  /** All subscription rows + live guild names, active first. */
  @Get()
  async list() {
    const rows = await this.subRepo.find({ order: { updatedAt: 'DESC' } });
    const now = Date.now();
    return rows.map((r) => {
      const g = this.client.guilds.cache.get(r.guildId);
      const active = r.active && (!r.currentPeriodEnd || r.currentPeriodEnd.getTime() > now);
      return {
        guildId: r.guildId,
        guildName: g?.name ?? null,
        botOnGuild: Boolean(g),
        active,
        plan: r.plan,
        source: r.provider === 'stripe' ? 'stripe' : 'manual',
        until: r.currentPeriodEnd ? r.currentPeriodEnd.toISOString() : null,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Option B (§15.2): find a server by guild_id or name among servers the bot
   * is installed on.
   */
  @Get('search-guild')
  searchGuild(@Query('q') q?: string): GuildHit[] {
    const query = q?.trim().toLowerCase();
    if (!query) throw new BadRequestException('q required');
    const hits: GuildHit[] = [];
    for (const g of this.client.guilds.cache.values()) {
      if (g.id === query || g.name.toLowerCase().includes(query)) {
        hits.push(this.guildToHit(g));
        if (hits.length >= 25) break;
      }
    }
    return hits;
  }

  /**
   * Option A (§15.2): by Discord user ID or username — list servers where the
   * bot is installed AND the user is the owner or an administrator.
   */
  @Get('search-user')
  async searchUser(@Query('q') q?: string): Promise<GuildHit[]> {
    const query = q?.trim();
    if (!query) throw new BadRequestException('q required');
    const isId = /^\d{15,21}$/.test(query);
    const nameNeedle = query.toLowerCase();
    const hits: GuildHit[] = [];

    for (const g of this.client.guilds.cache.values()) {
      let member = null;
      if (isId) {
        member = g.members.cache.get(query) ?? (await g.members.fetch(query).catch(() => null));
      } else {
        member =
          g.members.cache.find(
            (m) =>
              m.user.username.toLowerCase() === nameNeedle ||
              m.displayName.toLowerCase() === nameNeedle,
          ) ??
          (await g.members
            .fetch({ query, limit: 1 })
            .then((c) => c.first() ?? null)
            .catch(() => null));
      }
      if (!member) continue;
      const isOwner = g.ownerId === member.id;
      const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
      if (!isOwner && !isAdmin) continue;
      hits.push({ ...this.guildToHit(g), userRole: isOwner ? 'owner' : 'admin' });
      if (hits.length >= 25) break;
    }
    return hits;
  }

  /** §15.3: activate premium for a guild for N days (manual grant). */
  @Post('grant')
  async grant(
    @Body() body: { guildId?: string; days?: number; reason?: string },
    @Req() req: Request,
  ) {
    const guildId = body?.guildId?.trim();
    const days = Number(body?.days);
    if (!guildId) throw new BadRequestException('guildId required');
    if (!Number.isFinite(days) || days < 1 || days > 3650) {
      throw new BadRequestException('days must be between 1 and 3650');
    }
    const admin = this.getAdmin(req);
    const guild = this.client.guilds.cache.get(guildId);
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const status = await this.premium.setPremium(guildId, true, {
      plan: 'premium',
      provider: 'manual',
      externalId: undefined,
      currentPeriodEnd: until,
    });

    await this.auditRepo.save(
      this.auditRepo.create({
        action: 'grant',
        guildId,
        guildName: guild?.name ?? null,
        adminId: admin.id,
        adminName: admin.username,
        durationDays: days,
        reason: body?.reason?.trim() || null,
        source: 'manual',
      }),
    );
    return status;
  }

  /**
   * §15.4: cancel any subscription (manual or Stripe) with immediate effect.
   * Stripe subscriptions are also cancelled via the Stripe API so no further
   * invoices are issued. Feature configs are preserved per the TZ.
   */
  @Post('cancel')
  async cancel(@Body() body: { guildId?: string; reason?: string }, @Req() req: Request) {
    const guildId = body?.guildId?.trim();
    if (!guildId) throw new BadRequestException('guildId required');
    const row = await this.premium.getSubscriptionRow(guildId);
    if (!row || !row.active) throw new NotFoundException('No active subscription for this server');

    const source = row.provider === 'stripe' ? 'stripe' : 'manual';
    if (source === 'stripe' && row.externalId) {
      try {
        await this.stripeService.cancelSubscriptionNow(row.externalId);
      } catch (e) {
        throw new BadRequestException(
          `Stripe cancellation failed: ${(e as Error).message}. Nothing was changed locally.`,
        );
      }
    }

    // Deactivate NOW, not at period end (§15.4).
    const admin = this.getAdmin(req);
    const guild = this.client.guilds.cache.get(guildId);
    const status = await this.premium.setPremium(guildId, false, { currentPeriodEnd: null });

    await this.auditRepo.save(
      this.auditRepo.create({
        action: 'cancel',
        guildId,
        guildName: guild?.name ?? null,
        adminId: admin.id,
        adminName: admin.username,
        durationDays: null,
        reason: body?.reason?.trim() || null,
        source,
      }),
    );
    return status;
  }

  /** §15.5: operation history, newest first. */
  @Get('history')
  async history(@Query('limit') limit?: string) {
    const take = Math.min(parseInt(limit ?? '100', 10) || 100, 500);
    const rows = await this.auditRepo.find({ order: { createdAt: 'DESC' }, take });
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      guildId: r.guildId,
      guildName: r.guildName,
      adminId: r.adminId,
      adminName: r.adminName,
      durationDays: r.durationDays,
      reason: r.reason,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
