-- Per-guild override of who can use which leveling command.
--
-- Background: Misha's TZ (part 2, §6) requires:
--   * /rank and /leaderboard available to @everyone by default;
--   * all /xp/* subcommands restricted to admins/mods by default;
--   * server admins can change either via the dashboard, optionally allowing
--     specific roles (e.g. a custom "Helper" role) to use a given command.
--
-- A row is OPTIONAL — when missing for a (server_id, command) pair the code
-- falls back to the hard-coded default in LEVELING_COMMANDS. This keeps the
-- table small and means we don't need to backfill on every guild creation.
--
-- mode semantics:
--   'everyone' — every server member can use the command
--   'admins'   — only members with the ManageMessages Discord permission
--                (admins inherit this implicitly)
--   'roles'    — allowed_role_ids is the whitelist; admins ALSO bypass so
--                they can't lock themselves out
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS leveling_command_permissions (
  server_id        text NOT NULL,
  command          text NOT NULL,
  mode             text NOT NULL CHECK (mode IN ('everyone', 'admins', 'roles')),
  allowed_role_ids text[] NOT NULL DEFAULT '{}',
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, command)
);

CREATE INDEX IF NOT EXISTS leveling_command_permissions_server_idx
  ON leveling_command_permissions (server_id);

COMMIT;
