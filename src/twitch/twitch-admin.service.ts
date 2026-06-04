import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureFlagsService } from '../common/feature-flags/feature-flags.service';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchSubscriptionManagerService } from './twitch-subscription-manager.service';

export interface AddResult {
  ok: true;
  subscription: StreamSubscription;
}
export interface AddError {
  ok: false;
  reason: 'limit_reached' | 'not_found' | 'duplicate' | 'invalid_username';
  message: string;
}

/**
 * Shared business logic for adding/removing/listing Twitch channels.
 *
 * Both the /twitch slash commands and the future dashboard REST controller
 * funnel through here, so the spec's "panel ↔ command parity" requirement
 * is satisfied automatically — one source of truth.
 *
 * Wraps the EventSub WebSocket service so callers don't need to know about
 * sessions or platform_event_subscriptions rows: add/remove just work.
 */
@Injectable()
export class TwitchAdminService {
  private readonly logger = new Logger(TwitchAdminService.name);
  /** Spec: 1–3 channels per server on launch, surfaced via the feature-flag service. */
  static readonly DEFAULT_CHANNELS_LIMIT = 3;

  constructor(
    @InjectRepository(StreamSubscription)
    private readonly streamRepo: Repository<StreamSubscription>,
    private readonly helix: TwitchHelixService,
    private readonly subs: TwitchSubscriptionManagerService,
    private readonly featureFlags: FeatureFlagsService,
  ) {}

  getLimit(guildId: string): number {
    return this.featureFlags.getFeatureLimit(
      guildId,
      'twitch_channels_limit',
      TwitchAdminService.DEFAULT_CHANNELS_LIMIT,
    );
  }

  async listForGuild(guildId: string): Promise<StreamSubscription[]> {
    return this.streamRepo.find({
      where: { guildId, platform: 'twitch' },
      order: { createdAt: 'ASC' },
    });
  }

  async addByUsername(
    guildId: string,
    rawUsername: string,
    discordChannelId: string,
  ): Promise<AddResult | AddError> {
    const username = rawUsername.trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{4,25}$/.test(username)) {
      return {
        ok: false,
        reason: 'invalid_username',
        message: `"${rawUsername}" is not a valid Twitch username (4–25 chars, a–z 0–9 _).`,
      };
    }

    const existing = await this.streamRepo.count({
      where: { guildId, platform: 'twitch' },
    });
    if (existing >= this.getLimit(guildId)) {
      return {
        ok: false,
        reason: 'limit_reached',
        message: `Channel limit reached (${this.getLimit(guildId)}). Remove one before adding another.`,
      };
    }

    const [user] = await this.helix.getUsersByLogin([username]);
    if (!user) {
      return {
        ok: false,
        reason: 'not_found',
        message: `Twitch user "${username}" not found.`,
      };
    }

    const dup = await this.streamRepo.findOne({
      where: { guildId, platform: 'twitch', platformUserId: user.id },
    });
    if (dup) {
      return {
        ok: false,
        reason: 'duplicate',
        message: `${user.display_name} is already tracked in this server.`,
      };
    }

    const row = this.streamRepo.create({
      guildId,
      discordChannelId,
      platform: 'twitch',
      platformUserId: user.id,
      platformUsername: user.display_name,
      enabled: true,
      embedConfig: {},
    });
    const saved = await this.streamRepo.save(row);

    try {
      await this.subs.ensureSubscriptionsFor(saved);
    } catch (e) {
      // Roll back the DB insert so the admin doesn't end up with a row
      // that has no EventSub backing. Bootstrap will retry creation on the
      // next session anyway, but we want adds to be atomic-feeling.
      this.logger.warn(
        `EventSub create failed for ${user.login}, rolling back DB row: ${(e as Error).message}`,
      );
      await this.streamRepo.delete(saved.id);
      throw e;
    }

    return { ok: true, subscription: saved };
  }

  async removeByUsername(guildId: string, rawUsername: string): Promise<boolean> {
    const username = rawUsername.trim().toLowerCase().replace(/^@/, '');
    const row = await this.streamRepo
      .createQueryBuilder('s')
      .where('s.guild_id = :guildId', { guildId })
      .andWhere('s.platform = :platform', { platform: 'twitch' })
      .andWhere('LOWER(s.platform_username) = :username', { username })
      .getOne();
    if (!row) return false;
    return this.removeById(guildId, row.id);
  }

  async removeById(guildId: string, subscriptionId: string): Promise<boolean> {
    const row = await this.streamRepo.findOne({ where: { id: subscriptionId, guildId } });
    if (!row) return false;
    try {
      await this.subs.removeSubscriptionsFor(row.id);
    } catch (e) {
      this.logger.warn(`Cleanup of EventSub for ${row.platformUsername} failed: ${(e as Error).message}`);
      // Continue: removing the DB row is the user's intent. Stranger Twitch
      // subscriptions will be cleaned up by reconciliation on next bootstrap.
    }
    await this.streamRepo.delete(row.id);
    return true;
  }
}
