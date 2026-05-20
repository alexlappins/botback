import { Injectable } from '@nestjs/common';

/**
 * Feature flag keys. Add to this union when introducing a new gated capability.
 */
export type FeatureKey =
  | 'leveling'
  | 'role_rewards_limit'
  | 'leveling_monthly_leaderboard'
  | 'xp_export'
  | 'tier_milestone_messages'
  | 'rank_card_background_image';

/**
 * Default capability matrix used when a server has no plan override yet.
 * On MVP every flag is enabled for every server (free, no gating).
 *
 * When Premium ships, replace `getDefault…` with a lookup against the
 * `plans` table joined via `servers.current_plan_id`. The service surface
 * (`hasFeature` / `getFeatureLimit`) stays unchanged — call sites don't
 * need to know whether they're talking to a real DB or the MVP fallback.
 */
@Injectable()
export class FeatureFlagsService {
  hasFeature(_serverId: string, _key: FeatureKey): boolean {
    return true;
  }

  getFeatureLimit(_serverId: string, key: FeatureKey, fallback?: number): number {
    return DEFAULT_LIMITS[key] ?? fallback ?? Number.MAX_SAFE_INTEGER;
  }
}

const DEFAULT_LIMITS: Partial<Record<FeatureKey, number>> = {
  role_rewards_limit: 50,
};
