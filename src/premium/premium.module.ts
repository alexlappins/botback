import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardModule } from '../dashboard/dashboard.module';
import { StoreModule } from '../store/store.module';
import { AdminSubscriptionsController } from './admin-subscriptions.controller';
import { GuildSubscription } from './entities/guild-subscription.entity';
import { SubscriptionAuditLog } from './entities/subscription-audit-log.entity';
import { PremiumController } from './premium.controller';
import { PremiumService } from './premium.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';

/**
 * @Global so any module (commands, listeners, controllers) can inject
 * PremiumService and call the single `isPremium(guildId)` gate without
 * importing this module — satisfies the TZ "centralized check" mandate.
 *
 * DashboardModule is imported (via forwardRef) only for GuildsService, used in
 * the controller's access check.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([GuildSubscription, SubscriptionAuditLog]),
    forwardRef(() => DashboardModule),
    // Shop checkout sessions share the Stripe account/webhook with premium —
    // the webhook controller routes shop events into StoreService (TZ-1 §4.2).
    forwardRef(() => StoreModule),
  ],
  controllers: [PremiumController, StripeWebhookController, AdminSubscriptionsController],
  providers: [PremiumService, StripeService],
  exports: [PremiumService, StripeService],
})
export class PremiumModule {}
