import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GuildMessage } from './entities/guild-message.entity';
import { GuildReactionRole } from './entities/guild-reaction-role.entity';
import { GuildDataController } from './guild-data.controller';
import { DashboardModule } from '../dashboard/dashboard.module';
import { CommonModule } from '../common/common.module';

/**
 * Per-guild snapshot data (messages + reaction-roles) editable from User Admin Panel.
 * Populated at template install; edits mirror to live Discord messages.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([GuildMessage, GuildReactionRole]),
    DashboardModule,
    CommonModule,
  ],
  controllers: [GuildDataController],
  exports: [TypeOrmModule],
})
export class GuildDataModule {}
