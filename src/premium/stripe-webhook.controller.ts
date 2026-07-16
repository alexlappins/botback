import { BadRequestException, Controller, Headers, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';

import { StoreService } from '../store/store.service';
import { StripeService } from './stripe.service';

/**
 * Stripe webhook receiver. Signature verification REQUIRES the raw request
 * bytes — main.ts mounts express.raw() for this exact path before Nest's JSON
 * parser (same pattern as the Twitch webhook).
 *
 * Always answer 2xx once the event is verified — Stripe retries on errors and
 * our handlers are idempotent, but hard failures inside a handler shouldn't
 * make Stripe hammer us.
 */
@Controller('api/stripe/webhook')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly store: StoreService,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Headers('stripe-signature') signature?: string) {
    if (!signature) throw new BadRequestException('Missing stripe-signature header');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? (req.body as Buffer);
    if (!Buffer.isBuffer(raw)) {
      throw new BadRequestException('Raw body unavailable — check express.raw() mount for this route');
    }

    let event;
    try {
      event = this.stripe.constructWebhookEvent(raw, signature);
    } catch (e) {
      this.logger.warn(`Rejected Stripe webhook: ${(e as Error).message}`);
      throw new BadRequestException('Invalid signature');
    }

    try {
      // One Stripe account, two flows (TZ-1 §4.2): shop purchases are
      // mode:payment sessions tagged metadata.type=shop_product; everything
      // else stays on the premium-subscription path untouched.
      const isShopCheckout =
        event.type === 'checkout.session.completed' &&
        (event.data.object as Stripe.Checkout.Session).metadata?.type === 'shop_product';
      if (isShopCheckout) {
        await this.store.handleStripeCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      } else {
        await this.stripe.handleEvent(event);
      }
    } catch (e) {
      // Log loudly but ack — handlers are idempotent and a retry storm helps no one.
      this.logger.error(`Stripe event ${event.type} (${event.id}) failed: ${(e as Error).message}`);
    }
    return { received: true };
  }
}
