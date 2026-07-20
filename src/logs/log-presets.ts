/**
 * Server Logs 2.0 (Misha's TZ §1): event-by-event toggles are replaced by
 * 7 preset groups. One preset = one on/off toggle + one destination channel.
 */
export const LOG_PRESETS = [
  'ban',
  'joinLeave',
  'messages',
  'moderation',
  'channel',
  'server',
  'voice',
] as const;

export type LogPreset = (typeof LOG_PRESETS)[number];

/**
 * Legacy per-event types (data/guilds.json) → new presets (TZ §8).
 * banKick covered bans AND kicks; kicks now live in joinLeave, bans in ban —
 * both presets get enabled so no server loses coverage.
 */
export const LEGACY_TYPE_TO_PRESETS: Record<string, LogPreset[]> = {
  banKick: ['ban', 'joinLeave'],
  joinLeave: ['joinLeave'],
  messages: ['messages'],
  moderation: ['moderation'],
  channel: ['channel'],
};
