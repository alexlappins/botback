import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CustomerGuard } from '../auth/customer.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionUser } from '../auth/session.serializer';
import { GuildsService } from '../dashboard/guilds.service';
import { PremiumService } from '../premium/premium.service';
import { ScheduledPost, type ScheduleKind } from './entities/scheduled-post.entity';
import { computeNextRun } from './scheduled-posts.service';

interface ScheduleBody {
  channelId?: string;
  content?: string | null;
  embedJson?: Record<string, unknown> | null;
  componentsJson?: unknown[] | null;
  kind?: ScheduleKind;
  /** ISO datetime — 'once' only. */
  runAt?: string;
  /** 'HH:MM' UTC — recurring kinds. */
  timeOfDay?: string;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  status?: 'active' | 'paused';
}

const KINDS: ScheduleKind[] = ['once', 'daily', 'weekly', 'monthly'];

/**
 * CRUD for scheduled posts (TZ v2.1 §2). Creating/editing schedules is
 * Premium-only; listing stays open so free guilds still see their saved
 * schedules (paused state) after an expiry.
 */
@Controller('api/guilds/:guildId/scheduled-posts')
@UseGuards(SessionGuard, CustomerGuard)
export class ScheduledPostsController {
  constructor(
    @InjectRepository(ScheduledPost)
    private readonly repo: Repository<ScheduledPost>,
    private readonly guilds: GuildsService,
    private readonly premium: PremiumService,
  ) {}

  private async ensureAccess(guildId: string, req: Request): Promise<void> {
    const user = (req as Request & { user: SessionUser }).user;
    const list = await this.guilds.getUserGuilds(user.accessToken, user.refreshToken);
    if (!list.some((g) => g.id === guildId)) {
      throw new UnauthorizedException('No access to this server');
    }
  }

  private async ensurePremium(guildId: string): Promise<void> {
    if (!(await this.premium.isPremium(guildId))) {
      throw new BadRequestException({
        message: 'Scheduled publishing is a Premium feature.',
        reason: 'premium_required',
      });
    }
  }

  @Get()
  async list(@Param('guildId') guildId: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    return this.repo.find({ where: { guildId }, order: { createdAt: 'DESC' } });
  }

  @Post()
  async create(@Param('guildId') guildId: string, @Body() body: ScheduleBody, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    await this.ensurePremium(guildId);
    const patch = this.validate(body, true);
    const row = this.repo.create({ guildId, status: 'active', runCount: 0, ...patch });
    row.nextRunAt = this.initialNextRun(row, body);
    if (!row.nextRunAt) throw new BadRequestException('Schedule never fires — check the recurrence fields');
    return this.repo.save(row);
  }

  @Put(':id')
  async update(
    @Param('guildId') guildId: string,
    @Param('id') id: string,
    @Body() body: ScheduleBody,
    @Req() req: Request,
  ) {
    await this.ensureAccess(guildId, req);
    await this.ensurePremium(guildId);
    const row = await this.repo.findOne({ where: { id, guildId } });
    if (!row) throw new NotFoundException('Scheduled post not found');
    Object.assign(row, this.validate(body, false));
    if (body.status === 'paused') row.status = 'paused';
    // 'done' rows are editable too (TZ §3): passing status:'active' re-arms a
    // fired post — initialNextRun below enforces a future runAt for one-offs.
    if (body.status === 'active') row.status = 'active';
    // Recompute the next run whenever timing fields may have changed.
    if (
      body.kind !== undefined || body.runAt !== undefined || body.timeOfDay !== undefined ||
      body.daysOfWeek !== undefined || body.dayOfMonth !== undefined || body.status === 'active'
    ) {
      row.nextRunAt = this.initialNextRun(row, body);
      if (!row.nextRunAt && row.kind !== 'once') {
        throw new BadRequestException('Schedule never fires — check the recurrence fields');
      }
    }
    return this.repo.save(row);
  }

  @Delete(':id')
  async remove(@Param('guildId') guildId: string, @Param('id') id: string, @Req() req: Request) {
    await this.ensureAccess(guildId, req);
    const res = await this.repo.delete({ id, guildId });
    if (!res.affected) throw new NotFoundException('Scheduled post not found');
    return { ok: true };
  }

  // ── Helpers ───────────────────────────────────────────

  private validate(body: ScheduleBody, isCreate: boolean): Partial<ScheduledPost> {
    const out: Partial<ScheduledPost> = {};
    if (isCreate || body.channelId !== undefined) {
      const ch = body.channelId?.toString().trim();
      if (!ch) throw new BadRequestException('channelId required');
      out.channelId = ch;
    }
    if (body.content !== undefined) out.content = body.content?.toString().trim() || null;
    if (body.embedJson !== undefined) out.embedJson = body.embedJson ?? null;
    if (body.componentsJson !== undefined) out.componentsJson = body.componentsJson ?? null;
    if (isCreate || body.kind !== undefined) {
      if (!body.kind || !KINDS.includes(body.kind)) {
        throw new BadRequestException(`kind must be one of: ${KINDS.join(', ')}`);
      }
      out.kind = body.kind;
    }
    if (body.timeOfDay !== undefined) {
      if (body.timeOfDay && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.timeOfDay)) {
        throw new BadRequestException('timeOfDay must be HH:MM (UTC)');
      }
      out.timeOfDay = body.timeOfDay || null;
    }
    if (body.daysOfWeek !== undefined) {
      const days = (body.daysOfWeek ?? []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      out.daysOfWeek = days.length ? [...new Set(days)] : null;
    }
    if (body.dayOfMonth !== undefined) {
      const d = Number(body.dayOfMonth);
      if (body.dayOfMonth != null && (!Number.isInteger(d) || d < 1 || d > 31)) {
        throw new BadRequestException('dayOfMonth must be 1–31');
      }
      out.dayOfMonth = body.dayOfMonth == null ? null : d;
    }
    if (isCreate && !out.content && !out.embedJson && !(out.componentsJson && out.componentsJson.length)) {
      throw new BadRequestException('Provide at least content, embed, or components');
    }
    return out;
  }

  private initialNextRun(row: ScheduledPost, body: ScheduleBody): Date | null {
    if (row.kind === 'once') {
      const d = body.runAt ? new Date(body.runAt) : row.nextRunAt;
      if (!d || Number.isNaN(d.getTime())) throw new BadRequestException('runAt (ISO datetime) required for one-off schedules');
      if (d.getTime() <= Date.now()) throw new BadRequestException('runAt must be in the future');
      return d;
    }
    if (!row.timeOfDay) throw new BadRequestException('timeOfDay (HH:MM UTC) required for recurring schedules');
    if (row.kind === 'weekly' && !(row.daysOfWeek && row.daysOfWeek.length)) {
      throw new BadRequestException('daysOfWeek required for weekly schedules');
    }
    if (row.kind === 'monthly' && !row.dayOfMonth) {
      throw new BadRequestException('dayOfMonth required for monthly schedules');
    }
    return computeNextRun(row, new Date());
  }
}
