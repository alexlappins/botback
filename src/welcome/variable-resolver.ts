import type { Guild, GuildMember, User } from 'discord.js';

/**
 * Resolves {key} placeholders in welcome/goodbye text.
 *
 * Supported variables:
 *   {user}              — mention (<@id>)
 *   {user.name}         — username
 *   {user.tag}          — username#discriminator (or just username for new accounts)
 *   {user.id}           — id
 *   {user.created}      — ISO date of account creation
 *   {server}            — server name
 *   {server.name}       — server name
 *   {server.id}         — server id
 *   {server.memberCount}— current member count
 *   {memberCount}       — alias for {server.memberCount}
 *
 * Unknown variables are left unchanged (no errors thrown).
 */
export function resolveVariables(
  text: string,
  ctx: { user: User; member?: GuildMember | null; guild: Guild },
): string {
  if (!text) return text;
  const { user, guild } = ctx;
  const vars: Record<string, string> = {
    user: `<@${user.id}>`,
    'user.name': user.username,
    'user.tag':
      'discriminator' in user && user.discriminator && user.discriminator !== '0'
        ? `${user.username}#${user.discriminator}`
        : user.username,
    'user.id': user.id,
    'user.created': user.createdAt?.toISOString() ?? '',
    server: guild.name,
    'server.name': guild.name,
    'server.id': guild.id,
    'server.memberCount': String(guild.memberCount ?? 0),
    memberCount: String(guild.memberCount ?? 0),
  };
  return text.replace(/\{([\w.]+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

/** List of supported variables for the dashboard UI. */
export const SUPPORTED_VARIABLES = [
  { key: '{user}', desc: 'User mention (@username)' },
  { key: '{user.name}', desc: 'Username (no @)' },
  { key: '{user.tag}', desc: 'Username with discriminator' },
  { key: '{user.id}', desc: 'User ID' },
  { key: '{server.name}', desc: 'Server name' },
  { key: '{server.memberCount}', desc: 'Current member count' },
];
