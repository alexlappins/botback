/**
 * ALL Server Alerts thresholds in one place (TZ §5) — never scatter these
 * through detector code. Values below are the TZ defaults.
 */
export const ALERTS_CONFIG = {
  /** Global per-(guild, detector) re-alert cooldown, ms (TZ §4.3). */
  cooldownMs: 30 * 60 * 1000,

  d1: {
    windowMs: 10 * 60 * 1000,
    minJoins: 10,
    youngAccountDays: 7,
    youngShare: 0.5,
    hardJoins: 20,
    /** Quiet period after which the aggregated raid alert gets its final summary. */
    settleMs: 10 * 60 * 1000,
  },
  d2: { windowMs: 10 * 60 * 1000, deletions: 3 },
  d3: { windowMs: 10 * 60 * 1000, actions: 4 },
  d4: {
    dangerousPermissions: [
      'Administrator',
      'ManageGuild',
      'ManageRoles',
      'BanMembers',
      'ManageWebhooks',
    ] as const,
  },
  d5: { windowMs: 60 * 60 * 1000, minLeaves: 5, leaveShare: 0.03, cooldownMs: 6 * 60 * 60 * 1000 },
  d8: { windowMs: 5 * 60 * 1000, deletions: 10 },
} as const;

export const DETECTOR_SEVERITY: Record<string, 'critical' | 'warning'> = {
  d1: 'critical',
  d2: 'critical',
  d3: 'warning',
  d4: 'warning',
  d5: 'warning',
  d6: 'warning',
  d7: 'warning',
  d8: 'warning',
  d9: 'warning',
};
