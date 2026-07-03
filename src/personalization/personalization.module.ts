import { forwardRef, Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardModule } from '../dashboard/dashboard.module';
import { BotPersonalization } from './entities/bot-personalization.entity';
import { WebhookCache } from './entities/webhook-cache.entity';
import { BotPersonalizationController } from './bot-personalization.controller';
import { BotPersonalizationService } from './bot-personalization.service';

/**
 * @Global — every feature that posts to a channel (welcome, leveling, twitch,
 * scheduler) routes through BotPersonalizationService.sendBotMessage(), so it
 * has to be injectable everywhere without explicit imports.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([BotPersonalization, WebhookCache]),
    forwardRef(() => DashboardModule),
  ],
  controllers: [BotPersonalizationController],
  providers: [BotPersonalizationService],
  exports: [BotPersonalizationService],
})
export class PersonalizationModule {}
