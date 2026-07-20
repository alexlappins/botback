import { Injectable } from '@nestjs/common';
import type { Guild, GuildMember } from 'discord.js';

export type JoinVerdict = 'allow' | 'kick' | 'quarantine';

/**
 * Decoupling hub for the Security Suite. Security registers its capabilities
 * here; logs/welcome/leveling/twitch consume them — no module cycles.
 * Every slot has a safe no-op default, so the app runs fine even if the
 * security module is disabled or not yet initialised.
 */
@Injectable()
export class SecurityBridge {
  /** §1.2 — whitelisted users skip auto-actions and D2/D3 counters. */
  isWhitelisted: (guildId: string, userId: string) => Promise<boolean> = async () => false;

  /**
   * §2.2 — member-join pipeline gate. Memoized per join: the FIRST caller
   * triggers the age-filter decision; everyone else awaits the same promise.
   * 'kick' → welcome/XP/detectors must all stop.
   */
  gateJoin: (member: GuildMember) => Promise<JoinVerdict> = async () => 'allow';

  /** §6.4 — quarantined members get no XP and no welcome. */
  isQuarantined: (member: GuildMember) => boolean = () => false;

  /** §8.2 — Stream Shield sensitivity multiplier (1 = normal, 0.6 = alert earlier). */
  thresholdMultiplier: (guildId: string) => number = () => 1;

  /**
   * §4 — anti-raid auto-action for one raid join. Returns note lines for the
   * alert (e.g. "quarantined", "⚠️ missing permissions").
   */
  onRaidJoin?: (guild: Guild, userId: string) => Promise<string[]>;

  /** §4.1 — auto-panic on raid, if enabled. Returns note lines. */
  onRaidStart?: (guild: Guild) => Promise<string[]>;

  /** §5 — anti-nuke auto-action against the executor. Returns note lines + incident id. */
  onNukeExecutor?: (
    guild: Guild,
    detector: string,
    executorId: string,
  ) => Promise<{ notes: string[]; incidentId: string | null }>;

  /**
   * §7 — action-button rows for an alert embed, keyed by detector.
   * Returns discord.js ActionRowBuilder[] (typed loosely to avoid deps here).
   */
  alertComponents?: (guildId: string, detector: string, incidentId: string, actorUserId: string | null) => unknown[];

  /** §8 — Stream Shield hooks, called by the Twitch notification pipeline. */
  onStreamOnline?: (guildId: string, subId: string, streamer: string, streamTitle: string | null) => Promise<void>;
  onStreamOffline?: (guildId: string, subId: string, streamer: string) => Promise<void>;

  /** Registered BY AlertsService — lets security notify alert recipients (§3.5). */
  notifyRecipients?: (guildId: string, title: string, lines: string[], severity: 'critical' | 'warning') => Promise<void>;
}
