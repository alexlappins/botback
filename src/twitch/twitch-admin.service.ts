import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FeatureFlagsService } from '../common/feature-flags/feature-flags.service';
import { PremiumService } from '../premium/premium.service';
import { StreamSubscription } from './entities/stream-subscription.entity';
import { TwitchHelixService } from './twitch-helix.service';
import { TwitchSubscriptionManagerService } from './twitch-subscription-manager.service';

export interface AddResult {
  ok: true;
  subscription: StreamSubscription;
}
export interface AddError {
  ok: false;
  reason:
    | 'limit_reached'
    | 'not_found'
    | 'duplicate'
    | 'invalid_username'
    | 'not_configured'
    | 'subscription_failed'
    | 'premium_required';
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
    private readonly premium: PremiumService,
  ) {}

  getLimit(guildId: string): number {
    return this.featureFlags.getFeatureLimit(
      guildId,
      'twitch_channels_limit',
      TwitchAdminService.DEFAULT_CHANNELS_LIMIT,
    );
  }

  /**
   * Plan-aware limit (TZ v2.1 §7): free = 1 tracked channel, premium = the
   * feature-flag limit. Used by addByUsername; existing rows above the limit
   * are never deleted — they just stop notifying (gated in
   * StreamNotificationsService) until premium returns.
   */
  async getLimitFor(guildId: string): Promise<number> {
    if (await this.premium.isPremium(guildId)) return this.getLimit(guildId);
    return 1;
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

    // Webhook transport needs a public HTTPS callback + secret. Without them
    // ensureSubscriptionsFor() silently no-ops and the channel would be saved
    // with no EventSub backing (notifications never arrive). Fail fast with an
    // actionable message instead of a misleading "added".
    if (!this.subs.webhookConfigured()) {
      return {
        ok: false,
        reason: 'not_configured',
        message:
          'Twitch notifications are not configured on the bot — set TWITCH_WEBHOOK_CALLBACK_URL (a public HTTPS URL) and TWITCH_WEBHOOK_SECRET (10–100 chars), then restart.',
      };
    }

    const existing = await this.streamRepo.count({
      where: { guildId, platform: 'twitch' },
    });
    const limit = await this.getLimitFor(guildId);
    if (existing >= limit) {
      return {
        ok: false,
        reason: limit === 1 ? 'premium_required' : 'limit_reached',
        message:
          limit === 1
            ? 'The free plan tracks one Twitch channel. Upgrade to Premium to track more.'
            : `Channel limit reached (${limit}). Remove one before adding another.`,
      };
    }

    let user;
    try {
      [user] = await this.helix.getUsersByLogin([username]);
    } catch (e) {
      // Helix lookup itself failed — almost always an app-token problem
      // (wrong client id/secret, or Twitch 401/403). Surface it instead of
      // letting it bubble up as a 500.
      return {
        ok: false,
        reason: 'subscription_failed',
        message: `Could not reach Twitch to look up "${username}": ${(e as Error).message}. Check TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.`,
      };
    }
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
      const detail = (e as Error).message;
      this.logger.warn(
        `EventSub create failed for ${user.login}, rolling back DB row: ${detail}`,
      );
      await this.streamRepo.delete(saved.id);
      // Return a typed error rather than re-throwing — an EventSub rejection is
      // an expected, user-actionable condition (bad callback URL, Twitch 4xx),
      // not a server fault. Re-throwing surfaced it to the client as an opaque
      // 500 "Internal server error"; this carries the real Twitch reason.
      return {
        ok: false,
        reason: 'subscription_failed',
        message: `Twitch rejected the subscription: ${detail}. Verify TWITCH_WEBHOOK_CALLBACK_URL is a public HTTPS URL Twitch can reach and the secret is 10–100 chars.`,
      };
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
