import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GuildSubscription } from './entities/guild-subscription.entity';

export interface PremiumStatus {
  premium: boolean;
  plan: string;
  /** ISO string of when the current period ends, or null for open-ended/none. */
  until: string | null;
}

/**
 * THE single premium gate (Misha TZ v2.1, "ОБЩИЕ ПРИНЦИПЫ").
 *
 * Every premium check across the bot — slash commands, listeners, dashboard
 * controllers — MUST go through `isPremium(guildId)`. No hardcoded
 * `if (guildId === '...')` anywhere. When the billing model changes, only this
 * service changes; call sites stay identical.
 *
 * Expiry never deletes feature data — it only flips `active`/period here. Each
 * feature reads this flag at runtime and silently no-ops its premium parts when
 * false, re-activating when premium returns.
 */
@Injectable()
export class PremiumService {
  private readonly logger = new Logger(PremiumService.name);

  constructor(
    @InjectRepository(GuildSubscription)
    private readonly repo: Repository<GuildSubscription>,
  ) {}

  /** Canonical premium check. Safe-by-default: any error → treated as free. */
  async isPremium(guildId: string): Promise<boolean> {
    if (!guildId) return false;
    try {
      const row = await this.repo.findOne({ where: { guildId } });
      return this.isActive(row);
    } catch (e) {
      this.logger.warn(`isPremium(${guildId}) lookup failed, treating as free: ${(e as Error).message}`);
      return false;
    }
  }

  /** Raw subscription row — used by billing code (Stripe portal) only. */
  async getSubscriptionRow(guildId: string): Promise<GuildSubscription | null> {
    return this.repo.findOne({ where: { guildId } }).catch(() => null);
  }

  async getStatus(guildId: string): Promise<PremiumStatus> {
    const row = await this.repo.findOne({ where: { guildId } }).catch(() => null);
    const premium = this.isActive(row);
    return {
      premium,
      plan: premium ? (row?.plan ?? 'premium') : 'free',
      until: row?.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    };
  }

  /**
   * Set/clear premium for a guild. Used by the admin toggle now and by the
   * payment-provider webhook later (same entry point, different caller).
   * `currentPeriodEnd = null` → open-ended grant.
   */
  async setPremium(
    guildId: string,
    active: boolean,
    opts: { plan?: string; provider?: string; externalId?: string; currentPeriodEnd?: Date | null } = {},
  ): Promise<PremiumStatus> {
    const existing = await this.repo.findOne({ where: { guildId } });
    const row =
      existing ??
      this.repo.create({ guildId, active: false, plan: 'premium', provider: null, externalId: null, currentPeriodEnd: null });
    row.active = active;
    if (opts.plan !== undefined) row.plan = opts.plan;
    if (opts.provider !== undefined) row.provider = opts.provider;
    if (opts.externalId !== undefined) row.externalId = opts.externalId;
    if (opts.currentPeriodEnd !== undefined) row.currentPeriodEnd = opts.currentPeriodEnd;
    await this.repo.save(row);
    return this.getStatus(guildId);
  }

  private isActive(row: GuildSubscription | null): boolean {
    if (!row || !row.active) return false;
    if (row.currentPeriodEnd && row.currentPeriodEnd.getTime() <= Date.now()) return false;
    return true;
  }
}
