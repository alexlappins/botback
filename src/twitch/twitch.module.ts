import { forwardRef, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FeatureFlagsModule } from '../common/feature-flags/feature-flags.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { PlatformEventSubscription } from './entities/platform-event-subscription.entity';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { StreamNotificationsService } from './stream-notifications.service';
import { TwitchAdminService } from './twitch-admin.service';
import { TwitchCommands } from './twitch.commands';
import { TwitchController } from './twitch.controller';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchSubscriptionManagerService } from './twitch-subscription-manager.service';
import { TwitchTokenService } from './twitch-token.service';
import { TwitchWebhookController } from './twitch-webhook.controller';

/**
 * Twitch (and future YouTube/Kick/TikTok) live-stream notifications module.
 *
 * Webhook-based EventSub:
 *   - TwitchWebhookController receives events at /api/twitch/webhook
 *   - TwitchSubscriptionManagerService owns creation / reconciliation
 *   - StreamNotificationsService renders + ships the Discord embed
 *
 * If TWITCH_CLIENT_ID/SECRET aren't set the module still loads but stays
 * passive — admin actions surface a clear "not configured" error.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([StreamSubscription, PlatformEventSubscription]),
    ConfigModule,
    FeatureFlagsModule,
    // forwardRef in case DashboardModule grows to import TwitchModule later
    // (it doesn't today); harmless when there's no cycle yet.
    forwardRef(() => DashboardModule),
  ],
  controllers: [TwitchController, TwitchWebhookController],
  providers: [
    TwitchTokenService,
    TwitchHelixService,
    TwitchSubscriptionManagerService,
    StreamNotificationsService,
    TwitchAdminService,
    TwitchCommands,
  ],
  exports: [TwitchAdminService],
})
export class TwitchModule {}
