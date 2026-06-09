import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardModule } from '../dashboard/dashboard.module';
import { FeatureFlagsModule } from '../common/feature-flags/feature-flags.module';
import { ServerTemplate } from '../server-templates/entities/server-template.entity';

import { IgnoredUser } from './entities/ignored-user.entity';
import { LevelingCommandPermission } from './entities/leveling-command-permission.entity';
import { NoXpChannel } from './entities/no-xp-channel.entity';
import { NoXpRole } from './entities/no-xp-role.entity';
import { RoleReward } from './entities/role-reward.entity';
import { ServerLevelingSettings } from './entities/server-leveling-settings.entity';
import { ServerTier } from './entities/server-tier.entity';
import { TemplateLevelingSettings } from './entities/template-leveling-settings.entity';
import { TemplateNoXpChannel } from './entities/template-no-xp-channel.entity';
import { TemplateNoXpRole } from './entities/template-no-xp-role.entity';
import { TemplateRoleReward } from './entities/template-role-reward.entity';
import { TemplateTier } from './entities/template-tier.entity';
import { UserXp } from './entities/user-xp.entity';
import { XpEventLog } from './entities/xp-event-log.entity';

import { AvatarCacheService } from './avatar-cache.service';
import { LevelingPermissionsService } from './leveling-permissions.service';
import { LevelingService } from './leveling.service';
import { LevelingController } from './leveling.controller';
import { LevelingListeners } from './leveling.listeners';
import {
  LevelingLeaderboardComponents,
  LevelingPublicCommands,
  XpAdminCommands,
} from './leveling.commands';
import { RankCardCacheService } from './rank-card-cache.service';
import { RankCardRendererService } from './rank-card-renderer.service';
import { TemplateLevelingAdminController } from './template-leveling-admin.controller';
import { TemplateLevelingDeployService } from './template-leveling-deploy.service';
import { VoiceTickService } from './voice-tick.service';

/**
 * Leveling MVP. Free for everyone, gated by FeatureFlagsService so we can
 * carve Premium-only capabilities later without touching call sites.
 *
 * Iteration 1 covers: entities, XP engine (chat + voice), tier/role-reward
 * logic, slash commands, dashboard REST. Rank-card PNG, the dashboard UI
 * itself, and template integration land in subsequent iterations.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ServerLevelingSettings,
      ServerTier,
      UserXp,
      RoleReward,
      NoXpRole,
      NoXpChannel,
      IgnoredUser,
      XpEventLog,
      LevelingCommandPermission,
      // Template-side mirrors — owned by the leveling domain so the deploy
      // service can read them with @InjectRepository. Exposed via TypeOrmModule
      // export below so the server-templates module can wire its REST endpoints.
      TemplateLevelingSettings,
      TemplateTier,
      TemplateRoleReward,
      TemplateNoXpRole,
      TemplateNoXpChannel,
      // ServerTemplate is owned by ServerTemplatesModule, but we need its repo
      // here so the owner-admin controller can validate `template_id` and
      // toggle `leveling_enabled` without going cross-module.
      ServerTemplate,
    ]),
    // forwardRef breaks the cycle:
    // DashboardModule → ServerTemplatesModule → LevelingModule → DashboardModule.
    // LevelingController injects GuildsService for guild-access checks; that
    // lookup is request-time, so deferring resolution via forwardRef is safe.
    forwardRef(() => DashboardModule),
    FeatureFlagsModule,
  ],
  controllers: [LevelingController, TemplateLevelingAdminController],
  providers: [
    LevelingService,
    LevelingPermissionsService,
    LevelingListeners,
    VoiceTickService,
    LevelingPublicCommands,
    LevelingLeaderboardComponents,
    XpAdminCommands,
    TemplateLevelingDeployService,
    AvatarCacheService,
    RankCardRendererService,
    RankCardCacheService,
  ],
  exports: [LevelingService, LevelingPermissionsService, TemplateLevelingDeployService],
})
export class LevelingModule {}
