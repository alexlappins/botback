import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';

import { PremiumService } from './premium.service';

/**
 * Stripe billing for the Premium subscription (monthly, per guild).
 *
 * Flow:
 *   1. Dashboard calls createCheckoutSession(guildId) → Stripe-hosted page.
 *      The guildId rides in metadata + subscription metadata.
 *   2. Stripe calls our webhook:
 *        checkout.session.completed          → premium ON (period end from sub)
 *        invoice.paid                        → renewals: extend period end
 *        customer.subscription.updated       → sync period end / cancel state
 *        customer.subscription.deleted       → premium OFF
 *      All of them funnel into PremiumService.setPremium — the same single
 *      source of truth the manual admin toggle uses, so feature gates need no
 *      Stripe awareness at all.
 *
 * Required env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID.
 * Optional: FRONTEND_URL (redirect target after checkout).
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly config: ConfigService,
    private readonly premium: PremiumService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key) : null;
    if (!this.stripe) {
      this.logger.warn('STRIPE_SECRET_KEY not set — premium checkout is disabled');
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.stripe &&
        this.config.get<string>('STRIPE_WEBHOOK_SECRET') &&
        this.config.get<string>('STRIPE_PRICE_ID'),
    );
  }

  /** Stripe-hosted checkout page URL for subscribing a guild to Premium. */
  async createCheckoutSession(guildId: string, userId: string): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Payments are not configured on this bot');
    const priceId = this.config.get<string>('STRIPE_PRICE_ID');
    if (!priceId) throw new BadRequestException('STRIPE_PRICE_ID is not configured');

    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      // guildId in BOTH places: session metadata for checkout.session.completed,
      // subscription metadata so later invoice/subscription events carry it too.
      metadata: { guildId, userId },
      subscription_data: { metadata: { guildId, userId } },
      success_url: `${frontend}/premium/success?guild=${encodeURIComponent(guildId)}`,
      cancel_url: `${frontend}/pricing?canceled=1`,
      // One subscription per guild: clientReferenceId helps reconcile manually.
      client_reference_id: guildId,
      allow_promotion_codes: true,
    });
    if (!session.url) throw new BadRequestException('Stripe did not return a checkout URL');
    return session.url;
  }

  /** Stripe Customer Portal URL so subscribers can cancel/update card themselves. */
  async createPortalSession(guildId: string): Promise<string> {
    if (!this.stripe) throw new BadRequestException('Payments are not configured on this bot');
    const status = await this.premium.getSubscriptionRow(guildId);
    if (!status?.externalId) throw new BadRequestException('No active subscription for this server');
    const sub = await this.stripe.subscriptions.retrieve(status.externalId);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const frontend = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
    const portal = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontend}/`,
    });
    return portal.url;
  }

  /** Verify signature and construct the event from the RAW request body. */
  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    if (!this.stripe) throw new BadRequestException('Payments are not configured');
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not configured');
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  /** Route a verified Stripe event into PremiumService. Idempotent by design. */
  async handleEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const guildId = session.metadata?.guildId;
        if (!guildId || session.mode !== 'subscription' || !session.subscription) return;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const periodEnd = await this.fetchPeriodEnd(subId);
        await this.premium.setPremium(guildId, true, {
          provider: 'stripe',
          externalId: subId,
          currentPeriodEnd: periodEnd,
        });
        this.logger.log(`Premium activated for guild ${guildId} (sub ${subId})`);
        return;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        const subId = this.subscriptionIdFromInvoice(invoice);
        if (!subId) return;
        const sub = await this.stripe!.subscriptions.retrieve(subId);
        const guildId = sub.metadata?.guildId;
        if (!guildId) return;
        await this.premium.setPremium(guildId, true, {
          provider: 'stripe',
          externalId: sub.id,
          currentPeriodEnd: this.periodEndOf(sub),
        });
        this.logger.log(`Premium renewed for guild ${guildId} until ${this.periodEndOf(sub)?.toISOString()}`);
        return;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const guildId = sub.metadata?.guildId;
        if (!guildId) return;
        // active/trialing keep premium (period end still bounds it);
        // canceled/unpaid/past_due beyond grace turn it off at period end
        // naturally because isPremium checks currentPeriodEnd.
        const on = sub.status === 'active' || sub.status === 'trialing';
        await this.premium.setPremium(guildId, on, {
          provider: 'stripe',
          externalId: sub.id,
          currentPeriodEnd: this.periodEndOf(sub),
        });
        return;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const guildId = sub.metadata?.guildId;
        if (!guildId) return;
        await this.premium.setPremium(guildId, false, {
          provider: 'stripe',
          externalId: sub.id,
        });
        this.logger.log(`Premium canceled for guild ${guildId}`);
        return;
      }
      default:
        // Unhandled event types are fine — we only subscribed to what we need.
        return;
    }
  }

  // ── Internals ─────────────────────────────────────────

  private async fetchPeriodEnd(subscriptionId: string): Promise<Date | null> {
    try {
      const sub = await this.stripe!.subscriptions.retrieve(subscriptionId);
      return this.periodEndOf(sub);
    } catch {
      return null;
    }
  }

  /** current_period_end moved from Subscription to its items in newer API versions. */
  private periodEndOf(sub: Stripe.Subscription): Date | null {
    const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
    const itemEnd = sub.items?.data?.[0]?.current_period_end;
    const ts = legacy ?? itemEnd;
    return ts ? new Date(ts * 1000) : null;
  }

  private subscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
    // API ≥2025: invoice.parent.subscription_details.subscription; older: invoice.subscription.
    const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
    if (legacy) return typeof legacy === 'string' ? legacy : legacy.id;
    const parent = (invoice as unknown as {
      parent?: { subscription_details?: { subscription?: string | { id: string } } };
    }).parent;
    const viaParent = parent?.subscription_details?.subscription;
    if (viaParent) return typeof viaParent === 'string' ? viaParent : viaParent.id;
    return null;
  }
}
