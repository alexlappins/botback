import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { GoodbyeConfig } from '../welcome/entities/goodbye-config.entity';
import { WelcomeConfig } from '../welcome/entities/welcome-config.entity';
import { LogSettings } from '../logs/entities/log-settings.entity';
import { PendingInstall } from '../store/entities/pending-install.entity';
import { ServerSnapshot } from './entities/snapshot.entity';
import { SnapshotService } from './snapshot.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import {
  NukeIncident,
  PanicState,
  QuarantineRecord,
  SecuritySettings,
  SecurityWhitelistEntry,
} from './entities/security.entities';
import { PanicService } from './panic.service';
import { QuarantineService } from './quarantine.service';
import { SecurityActionsService } from './security-actions.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { StreamShieldService } from './stream-shield.service';

/**
 * Security Suite (Security TZ): whitelist, age filter, panic mode,
 * quarantine, anti-raid/anti-nuke auto-actions, alert buttons, stream shield.
 * Talks to logs/welcome/leveling/twitch exclusively through SecurityBridge.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SecuritySettings,
      SecurityWhitelistEntry,
      PanicState,
      QuarantineRecord,
      NukeIncident,
      ServerSnapshot,
      PendingInstall,
      LogSettings,
      WelcomeConfig,
      GoodbyeConfig,
    ]),
    CommonModule,
    DashboardModule,
  ],
  controllers: [SecurityController],
  providers: [SecurityService, PanicService, QuarantineService, SecurityActionsService, StreamShieldService, SnapshotService],
  exports: [SecurityService],
})
export class SecurityModule {}
