import type { Guild, User } from 'discord.js';
import type { ServerTier } from './entities/server-tier.entity';

export interface NotificationContext {
  user: User;
  guild: Guild;
  oldLevel: number;
  newLevel: number;
  newTier: ServerTier | null;
  oldTier: ServerTier | null;
}

/**
 * Resolve {placeholders} for level-up / tier-milestone messages.
 * Unknown placeholders are left untouched (no crash).
 *
 * Supported:
 *   {user}      mention
 *   {user_name} username
 *   {level}     new level (number)
 *   {old_level} previous level (number)
 *   {tier}      current tier name (or "")
 *   {new_tier}  alias for {tier} — emphasizes the transition
 *   {old_tier}  previous tier name (or "")
 *   {server}    guild name
 */
export function renderLevelupMessage(template: string, ctx: NotificationContext): string {
  if (!template) return '';
  const vars: Record<string, string> = {
    user: `<@${ctx.user.id}>`,
    user_name: ctx.user.username,
    level: String(ctx.newLevel),
    old_level: String(ctx.oldLevel),
    tier: ctx.newTier?.name ?? '',
    new_tier: ctx.newTier?.name ?? '',
    old_tier: ctx.oldTier?.name ?? '',
    server: ctx.guild.name,
  };
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}
