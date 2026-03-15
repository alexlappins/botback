import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import type { LogEventKind, LogEventType } from './entities/log-event.entity';
import { LogEvent } from './entities/log-event.entity';

const RETENTION_DAYS = 90;

export interface CreateLogEventDto {
  guildId: string;
  type: LogEventType;
  kind: LogEventKind;
  payload: Record<string, unknown>;
}

@Injectable()
export class LogEventsService {
  constructor(
    @InjectRepository(LogEvent)
    private readonly repo: Repository<LogEvent>,
  ) {}

  async create(dto: CreateLogEventDto): Promise<LogEvent> {
    const event = this.repo.create({
      guildId: dto.guildId,
      type: dto.type,
      kind: dto.kind,
      payload: dto.payload ?? {},
    });
    return this.repo.save(event);
  }

  async findAllByGuild(
    guildId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<LogEvent[]> {
    const limit = Math.min(options.limit ?? 50, 100);
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.guild_id = :guildId', { guildId })
      .orderBy('e.created_at', 'DESC')
      .take(limit);

    if (options.before) {
      const beforeEvent = await this.repo.findOne({
        where: { id: options.before, guildId },
      });
      if (beforeEvent) {
        qb.andWhere('e.created_at < :before', {
          before: beforeEvent.createdAt,
        });
      }
    }

    return qb.getMany();
  }

  /** Удалить события старше RETENTION_DAYS (3 месяца). Вызывается по крону. */
  async deleteOlderThanRetention(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    const result = await this.repo.delete({
      createdAt: LessThan(cutoff),
    });
    return result.affected ?? 0;
  }

  @Cron('0 3 * * *') // каждый день в 03:00
  async runRetentionCleanup(): Promise<void> {
    const deleted = await this.deleteOlderThanRetention();
    if (deleted > 0) {
      console.log(`[LogEvents] Удалено записей старше ${RETENTION_DAYS} дней: ${deleted}`);
    }
  }
}
