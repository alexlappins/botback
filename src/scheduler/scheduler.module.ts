import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DashboardModule } from '../dashboard/dashboard.module';
import { ScheduledPost } from './entities/scheduled-post.entity';
import { ScheduledPostsController } from './scheduled-posts.controller';
import { ScheduledPostsService } from './scheduled-posts.service';

@Module({
  imports: [TypeOrmModule.forFeature([ScheduledPost]), forwardRef(() => DashboardModule)],
  controllers: [ScheduledPostsController],
  providers: [ScheduledPostsService],
})
export class SchedulerModule {}
