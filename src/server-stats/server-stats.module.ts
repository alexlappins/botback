import { Module } from '@nestjs/common';
import { ServerStatsCommands } from './server-stats.commands';
import { ServerStatsService } from './server-stats.service';

/**
 * Статистика сервера в названиях каналов (клон ServerStats).
 * Создаёт категорию с 4 голосовыми каналами-счётчиками и обновляет их раз в 10 минут.
 */
@Module({
  providers: [ServerStatsService, ServerStatsCommands],
  exports: [ServerStatsService],
})
export class ServerStatsModule {}
