import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LogEvent } from './entities/log-event.entity';
import { LogsCommands } from './logs.commands';
import { LogEventsService } from './log-events.service';
import { LogsListeners } from './logs.listeners';

/**
 * Система журналов (MVP #3).
 * join/leave, message, moderation, channel, ban/kick logs
 * в назначенные каналы + запись в БД для ленты в дашборде.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LogEvent])],
  controllers: [],
  providers: [LogsCommands, LogsListeners, LogEventsService],
  exports: [LogEventsService],
})
export class LogsModule {}
