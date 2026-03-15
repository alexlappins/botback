import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { GuildsController } from './guilds.controller';
import { GuildsService } from './guilds.service';
import { LogsModule } from '../logs/logs.module';
import { ServerTemplatesModule } from '../server-templates/server-templates.module';

@Module({
  imports: [LogsModule, ServerTemplatesModule],
  controllers: [DashboardController, GuildsController],
  providers: [GuildsService],
  exports: [GuildsService],
})
export class DashboardModule {}
