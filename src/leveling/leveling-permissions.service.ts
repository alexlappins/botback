import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LevelingCommandPermission } from './entities/leveling-command-permission.entity';

/**
 * Canonical command keys used in DB and API. `xp.*` for /xp subcommands so the
 * value mirrors the slash-command path users see in Discord; flat names for
 * top-level commands.
 */
export type LevelingCommandKey =
  | 'rank'
  | 'leaderboard'
  | 'xp.give'
  | 'xp.remove'
  | 'xp.set'
  | 'xp.reset'
  | 'xp.ignore'
  | 'xp.recalc';

export type PermMode = 'everyone' | 'admins' | 'roles';

export interface CommandPermissionRow {
  command: LevelingCommandKey;
  mode: PermMode;
  allowedRoleIds: string[];
}

/**
 * Source of truth for every leveling command we expose. The dashboard reads
 * this list to know what rows to render; the gate uses it to fall back to
 * defaults when no override exists in DB. Adding a new command = append here
 * once, no extra migration needed.
 */
export const LEVELING_COMMANDS: { command: LevelingCommandKey; defaultMode: PermMode }[] = [
  { command: 'rank', defaultMode: 'everyone' },
  { command: 'leaderboard', defaultMode: 'everyone' },
  { command: 'xp.give', defaultMode: 'admins' },
  { command: 'xp.remove', defaultMode: 'admins' },
  { command: 'xp.set', defaultMode: 'admins' },
  { command: 'xp.reset', defaultMode: 'admins' },
  { command: 'xp.ignore', defaultMode: 'admins' },
  { command: 'xp.recalc', defaultMode: 'admins' },
];

const COMMAND_KEYS = new Set<LevelingCommandKey>(LEVELING_COMMANDS.map((c) => c.command));
const PERM_MODES = new Set<PermMode>(['everyone', 'admins', 'roles']);

@Injectable()
export class LevelingPermissionsService {
  constructor(
    @InjectRepository(LevelingCommandPermission)
    private readonly repo: Repository<LevelingCommandPermission>,
  ) {}

  /** Always returns one row per known command — DB overrides merged on top of
   *  defaults from {@link LEVELING_COMMANDS}. Callers don't need to special-case
   *  "no row" because we never return less than the full list. */
  async listForGuild(guildId: string): Promise<CommandPermissionRow[]> {
    const stored = await this.repo.find({ where: { serverId: guildId } });
    const byCmd = new Map(stored.map((r) => [r.command, r]));
    return LEVELING_COMMANDS.map(({ command, defaultMode }) => {
      const row = byCmd.get(command);
      return {
        command,
        mode: (row?.mode ?? defaultMode) as PermMode,
        allowedRoleIds: row?.allowedRoleIds ?? [],
      };
    });
  }

  async setForCommand(
    guildId: string,
    command: LevelingCommandKey,
    mode: PermMode,
    allowedRoleIds: string[],
  ): Promise<CommandPermissionRow> {
    if (!COMMAND_KEYS.has(command)) {
      throw new Error(`Unknown leveling command: ${command}`);
    }
    if (!PERM_MODES.has(mode)) {
      throw new Error(`Unknown permission mode: ${mode}`);
    }
    const cleanRoles = mode === 'roles' ? sanitizeRoleIds(allowedRoleIds) : [];
    const known = LEVELING_COMMANDS.find((c) => c.command === command)!;

    // Back to default ⇒ delete the row. Keeps the table compact and means a
    // future default change propagates without leftover overrides masking it.
    if (mode === known.defaultMode && cleanRoles.length === 0) {
      await this.repo.delete({ serverId: guildId, command });
      return { command, mode: known.defaultMode, allowedRoleIds: [] };
    }
    await this.repo.upsert(
      {
        serverId: guildId,
        command,
        mode,
        allowedRoleIds: cleanRoles,
      },
      ['serverId', 'command'],
    );
    return { command, mode, allowedRoleIds: cleanRoles };
  }

  /**
   * Gate used by command handlers. `hasManageMessages` is checked locally
   * (the member's resolved Discord permissions); admins bypass 'admins' AND
   * 'roles' so they can't lock themselves out of /xp recalc.
   */
  async canUse(
    guildId: string,
    command: LevelingCommandKey,
    memberRoleIds: Iterable<string>,
    hasManageMessages: boolean,
  ): Promise<boolean> {
    const rows = await this.listForGuild(guildId);
    const row = rows.find((r) => r.command === command);
    if (!row) return true; // defensive: defaults always populate the list

    switch (row.mode) {
      case 'everyone':
        return true;
      case 'admins':
        return hasManageMessages;
      case 'roles': {
        if (hasManageMessages) return true;
        const allow = new Set(row.allowedRoleIds);
        for (const id of memberRoleIds) {
          if (allow.has(id)) return true;
        }
        return false;
      }
    }
  }
}

/** Strip duplicates and reject anything that isn't a Discord snowflake-ish
 *  string. Cheap defence — the DB still has a text[] column, but admins
 *  shouldn't be able to inject garbage via the dashboard. */
function sanitizeRoleIds(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (/^\d{5,32}$/.test(t)) out.add(t);
  }
  return [...out];
}
