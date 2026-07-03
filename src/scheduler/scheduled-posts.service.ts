import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Client, TextChannel } from 'discord.js';
import { LessThanOrEqual, Repository } from 'typeorm';

import { BotPersonalizationService } from '../personalization/bot-personalization.service';
import { PremiumService } from '../premium/premium.service';
import { ScheduledPost } from './entities/scheduled-post.entity';

/**
 * Executes due scheduled posts (TZ v2.1 §2). Ticks every minute; a post fires
 * when `status=active` and `next_run_at <= now`.
 *
 * Premium gating happens AT TICK TIME via the central isPremium() — an expired
 * subscription means due posts are skipped (and their next_run_at advanced so
 * they don't pile up), never deleted. Renewal resumes the schedule as-is.
 */
@Injectable()
export class ScheduledPostsService {
  private readonly logger = new Logger(ScheduledPostsService.name);
  private ticking = false;

  constructor(
    @Inject(Client) private readonly client: Client,
    @InjectRepository(ScheduledPost)
    private readonly repo: Repository<ScheduledPost>,
    private readonly premium: PremiumService,
    private readonly personalization: BotPersonalizationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.ticking) return; // guard against overlapping ticks
    this.ticking = true;
    try {
      const due = await this.repo.find({
        where: { status: 'active', nextRunAt: LessThanOrEqual(new Date()) },
        take: 50,
        order: { nextRunAt: 'ASC' },
      });
      for (const post of due) {
        await this.executeOne(post).catch((e) =>
          this.logger.warn(`Scheduled post ${post.id} failed: ${(e as Error).message}`),
        );
      }
    } finally {
      this.ticking = false;
    }
  }

  private async executeOne(post: ScheduledPost): Promise<void> {
    const premium = await this.premium.isPremium(post.guildId);

    if (premium) {
      await this.send(post);
      post.lastRunAt = new Date();
      post.runCount += 1;
    } else {
      // Free: skip silently, keep the schedule intact for renewal (TZ общие принципы).
      this.logger.debug(`Skipping scheduled post ${post.id} — guild ${post.guildId} is not premium`);
    }

    // Advance regardless of premium so missed runs don't burst on renewal.
    if (post.kind === 'once') {
      post.status = 'done';
      post.nextRunAt = null;
    } else {
      post.nextRunAt = computeNextRun(post, new Date());
    }
    await this.repo.save(post);
  }

  private async send(post: ScheduledPost): Promise<void> {
    const guild =
      this.client.guilds.cache.get(post.guildId) ??
      (await this.client.guilds.fetch(post.guildId).catch(() => null));
    if (!guild) throw new Error('guild unavailable');
    const channel = guild.channels.cache.get(post.channelId);
    if (!channel?.isTextBased()) throw new Error('channel unavailable or not text');

    const embeds = post.embedJson ? [post.embedJson] : [];
    // Personalized identity on premium (TZ §8.2), plain bot send otherwise.
    await this.personalization.sendBotMessage(guild, channel as TextChannel, {
      content: post.content?.trim() || undefined,
      embeds: embeds as never,
      components: (post.componentsJson ?? []) as never,
    });
  }
}

/**
 * Compute the next UTC fire time strictly after `after`.
 * Exported for the controller (initial next_run_at on create/update).
 */
export function computeNextRun(
  post: Pick<ScheduledPost, 'kind' | 'timeOfDay' | 'daysOfWeek' | 'dayOfMonth' | 'nextRunAt'>,
  after: Date,
): Date | null {
  if (post.kind === 'once') return post.nextRunAt; // set explicitly by the API

  const [hh, mm] = (post.timeOfDay ?? '12:00').split(':').map((v) => parseInt(v, 10));
  const base = new Date(after);
  base.setUTCSeconds(0, 0);

  if (post.kind === 'daily') {
    const next = new Date(base);
    next.setUTCHours(hh, mm, 0, 0);
    if (next <= after) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }

  if (post.kind === 'weekly') {
    const days = (post.daysOfWeek ?? []).filter((d) => d >= 0 && d <= 6);
    if (!days.length) return null;
    for (let i = 0; i <= 7; i++) {
      const cand = new Date(base);
      cand.setUTCDate(cand.getUTCDate() + i);
      cand.setUTCHours(hh, mm, 0, 0);
      if (cand > after && days.includes(cand.getUTCDay())) return cand;
    }
    return null;
  }

  // monthly
  const dom = Math.min(Math.max(post.dayOfMonth ?? 1, 1), 31);
  for (let i = 0; i <= 12; i++) {
    const cand = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + i, 1, hh, mm, 0, 0));
    const daysInMonth = new Date(Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth() + 1, 0)).getUTCDate();
    cand.setUTCDate(Math.min(dom, daysInMonth));
    if (cand > after) return cand;
  }
  return null;
}
