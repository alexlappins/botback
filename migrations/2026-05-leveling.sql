-- Leveling MVP — Iteration 1 (data model + XP engine + commands + dashboard REST).
-- Rank-card visual fields are also included; the canvas renderer + dashboard UI
-- + template integration are coming in subsequent iterations but the schema is
-- already in place so future migrations don't need to touch these tables.
--
-- Idempotent: safe to re-run. Apply with:
--   psql "$DATABASE_URL" -f migrations/2026-05-leveling.sql

BEGIN;

-- ── server_leveling_settings ─────────────────────────────
CREATE TABLE IF NOT EXISTS server_leveling_settings (
  server_id                   varchar(32)  PRIMARY KEY,
  enabled                     boolean      NOT NULL DEFAULT false,
  levelup_channel_id          varchar(32),
  levelup_message_template    text         NOT NULL DEFAULT 'GG {user}! Ты достиг уровня {level}!',
  notify_only_new_tier        boolean      NOT NULL DEFAULT false,
  chat_xp_enabled             boolean      NOT NULL DEFAULT true,
  chat_xp_min                 int          NOT NULL DEFAULT 15,
  chat_xp_max                 int          NOT NULL DEFAULT 25,
  chat_xp_cooldown            int          NOT NULL DEFAULT 60,
  chat_xp_min_length          int          NOT NULL DEFAULT 10,
  voice_xp_enabled            boolean      NOT NULL DEFAULT true,
  voice_xp_per_minute         int          NOT NULL DEFAULT 10,
  voice_xp_min_users          int          NOT NULL DEFAULT 2,
  voice_xp_afk_minutes        int          NOT NULL DEFAULT 15,
  role_rewards_mode           varchar(16)  NOT NULL DEFAULT 'stack',
  rank_bg_image_url           varchar(1024),
  rank_bg_color               varchar(16)  NOT NULL DEFAULT '#1a1a1a',
  rank_overlay_opacity        int          NOT NULL DEFAULT 40,
  rank_primary_text_color     varchar(16)  NOT NULL DEFAULT '#FFFFFF',
  rank_secondary_text_color   varchar(16)  NOT NULL DEFAULT '#B0B0B0',
  rank_accent_color           varchar(16)  NOT NULL DEFAULT '#8b5cf6',
  rank_progress_color         varchar(16)  NOT NULL DEFAULT '#8b5cf6',
  rank_progress_bg_color      varchar(32)  NOT NULL DEFAULT 'rgba(255,255,255,0.2)',
  created_at                  timestamp    NOT NULL DEFAULT now(),
  updated_at                  timestamp    NOT NULL DEFAULT now()
);

-- ── server_tiers ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS server_tiers (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       varchar(32)  NOT NULL,
  name            varchar(64)  NOT NULL,
  emoji           varchar(64),
  icon_url        varchar(1024),
  start_level     int          NOT NULL,
  end_level       int          NOT NULL,
  color           varchar(16)  NOT NULL DEFAULT '#8b5cf6',
  levelup_message text,
  sort_order      int          NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS server_tiers_server_idx ON server_tiers (server_id);

-- ── user_xp (composite PK) ───────────────────────────────
CREATE TABLE IF NOT EXISTS user_xp (
  server_id            varchar(32) NOT NULL,
  discord_id           varchar(32) NOT NULL,
  total_xp             bigint      NOT NULL DEFAULT 0,
  level                int         NOT NULL DEFAULT 0,
  current_tier_id      uuid,
  monthly_xp           bigint      NOT NULL DEFAULT 0,
  last_message_at      timestamp,
  last_voice_check_at  timestamp,
  messages_count       bigint      NOT NULL DEFAULT 0,
  voice_minutes        bigint      NOT NULL DEFAULT 0,
  last_active_at       timestamp,
  created_at           timestamp   NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, discord_id)
);
CREATE INDEX IF NOT EXISTS user_xp_server_total_idx   ON user_xp (server_id, total_xp DESC);
CREATE INDEX IF NOT EXISTS user_xp_server_monthly_idx ON user_xp (server_id, monthly_xp DESC);

-- ── role_rewards (one role per level per guild) ──────────
CREATE TABLE IF NOT EXISTS role_rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   varchar(32) NOT NULL,
  level       int         NOT NULL,
  role_id     varchar(32) NOT NULL,
  CONSTRAINT role_rewards_server_level_uniq UNIQUE (server_id, level)
);
CREATE INDEX IF NOT EXISTS role_rewards_server_idx ON role_rewards (server_id);

-- ── no_xp_roles ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS no_xp_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   varchar(32) NOT NULL,
  role_id     varchar(32) NOT NULL,
  CONSTRAINT no_xp_roles_uniq UNIQUE (server_id, role_id)
);
CREATE INDEX IF NOT EXISTS no_xp_roles_server_idx ON no_xp_roles (server_id);

-- ── no_xp_channels ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS no_xp_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     varchar(32) NOT NULL,
  channel_id    varchar(32) NOT NULL,
  channel_type  varchar(8)  NOT NULL,
  CONSTRAINT no_xp_channels_uniq UNIQUE (server_id, channel_id)
);
CREATE INDEX IF NOT EXISTS no_xp_channels_server_idx ON no_xp_channels (server_id);

-- ── ignored_users ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ignored_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   varchar(32) NOT NULL,
  discord_id  varchar(32) NOT NULL,
  CONSTRAINT ignored_users_uniq UNIQUE (server_id, discord_id)
);
CREATE INDEX IF NOT EXISTS ignored_users_server_idx ON ignored_users (server_id);

-- ── xp_events_log (audit trail) ──────────────────────────
CREATE TABLE IF NOT EXISTS xp_events_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   varchar(32) NOT NULL,
  discord_id  varchar(32) NOT NULL,
  event_type  varchar(16) NOT NULL,
  xp_amount   int         NOT NULL,
  new_total   bigint      NOT NULL,
  new_level   int         NOT NULL,
  created_at  timestamp   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS xp_events_server_created_idx ON xp_events_log (server_id, created_at);

COMMIT;
