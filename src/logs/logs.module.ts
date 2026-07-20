import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommonModule } from '../common/common.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { WebhookCache } from '../personalization/entities/webhook-cache.entity';
import { AlertLog } from './entities/alert-log.entity';
import { AlertSettings } from './entities/alert-settings.entity';
import { LogEvent } from './entities/log-event.entity';
import { LogSettings } from './entities/log-settings.entity';
import { AlertsService } from './alerts.service';
import { AuditLookupService } from './audit-lookup.service';
import { InviteTrackerService } from './invite-tracker.service';
import { LogsCommands } from './logs.commands';
import { LogsController } from './logs.controller';
import { LogEventsService } from './log-events.service';
import { LogSettingsService } from './log-settings.service';
import { LogsListeners } from './logs.listeners';
import { MessageCacheService } from './message-cache.service';

/**
 * Server Logs 2.0 (TZ): 7 preset groups + Server Alerts watchdog.
 * One gateway listener feeds both log embeds and alert detectors.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([LogEvent, LogSettings, AlertSettings, AlertLog, WebhookCache]),
    CommonModule,
    // Dashboard imports Logs (event feed) and Logs needs GuildsService for
    // the access check — hence forwardRef on both sides.
    forwardRef(() => DashboardModule),
  ],
  controllers: [LogsController],
  providers: [
    LogsCommands,
    LogsListeners,
    LogEventsService,
    LogSettingsService,
    AuditLookupService,
    MessageCacheService,
    InviteTrackerService,
    AlertsService,
  ],
  exports: [LogEventsService, LogSettingsService],
})
export class LogsModule {}
