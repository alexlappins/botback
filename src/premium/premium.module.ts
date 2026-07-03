import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardModule } from '../dashboard/dashboard.module';
import { GuildSubscription } from './entities/guild-subscription.entity';
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
  imports: [TypeOrmModule.forFeature([GuildSubscription]), forwardRef(() => DashboardModule)],
  controllers: [PremiumController, StripeWebhookController],
  providers: [PremiumService, StripeService],
  exports: [PremiumService],
})
export class PremiumModule {}
