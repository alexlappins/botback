import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DashboardController } from './dashboard.controller';
import { GuildsController } from './guilds.controller';
import { GuildsService } from './guilds.service';
import { LogsModule } from '../logs/logs.module';
import { ServerTemplatesModule } from '../server-templates/server-templates.module';
import { UserTemplateAccess } from '../server-templates/entities/user-template-access.entity';

@Module({
  imports: [LogsModule, ServerTemplatesModule, TypeOrmModule.forFeature([UserTemplateAccess])],
  controllers: [DashboardController, GuildsController],
  providers: [GuildsService],
  exports: [GuildsService],
})
export class DashboardModule {}
