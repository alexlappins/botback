import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WelcomeConfig } from './entities/welcome-config.entity';
import { WelcomeTemplate } from './entities/welcome-template.entity';
import { GoodbyeConfig } from './entities/goodbye-config.entity';
import { GoodbyeTemplate } from './entities/goodbye-template.entity';
import { GuildMemberSeen } from './entities/guild-member-seen.entity';

import { WelcomeService } from './welcome.service';
import { WelcomeController } from './welcome.controller';
import { WelcomeListeners } from './welcome.listeners';
import { ImageRendererService } from './image-renderer.service';

import { DashboardModule } from '../dashboard/dashboard.module';

/**
 * Welcome / Goodbye system (Iteration 1 — text only).
 * Iteration 2 will add custom canvas image generation + returning-member detection.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      WelcomeConfig,
      WelcomeTemplate,
      GoodbyeConfig,
      GoodbyeTemplate,
      GuildMemberSeen,
    ]),
    DashboardModule,
  ],
  controllers: [WelcomeController],
  providers: [WelcomeService, WelcomeListeners, ImageRendererService],
  exports: [WelcomeService],
})
export class WelcomeModule {}
