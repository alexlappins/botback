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
import { TwitchEventSubService } from './twitch-eventsub.service';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchTokenService } from './twitch-token.service';

/**
 * Twitch (and future YouTube/Kick/TikTok) live-stream notifications module.
 *
 * Wires up the WS client + Helix REST + DB-backed notifier + admin service +
 * /twitch slash commands. If TWITCH_CLIENT_ID/SECRET aren't set the module
 * still loads, but TwitchTokenService.isConfigured() returns false and the
 * WS service refuses to connect — admin actions surface a clear error.
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
  controllers: [TwitchController],
  providers: [
    TwitchTokenService,
    TwitchHelixService,
    TwitchEventSubService,
    StreamNotificationsService,
    TwitchAdminService,
    TwitchCommands,
  ],
  exports: [TwitchAdminService],
})
export class TwitchModule {}
