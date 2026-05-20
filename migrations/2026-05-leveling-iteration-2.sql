-- Leveling — Iteration 2.
--
-- 1) Feature-flag / plan / Twitch readiness tables (`plans`, `servers`,
--    `server_features`). Currently unused at runtime (FeatureFlagsService
--    still returns hardcoded MVP values) but the schema is here so adding
--    Premium gating later does not require another migration.
-- 2) Drops `user_xp.last_voice_check_at` — was created in iteration 1 but
--    never read or written by any code path.
-- 3) Template-side leveling tables. Mirror the per-server tables but key on
--    `server_templates.id` and store roles/channels by NAME (resolved to
--    real IDs at install time).
--
-- Idempotent: safe to re-run. Apply with:
--   psql "$DATABASE_URL" -f migrations/2026-05-leveling-iteration-2.sql

BEGIN;

-- ── plans (one row per pricing plan) ─────────────────────
CREATE TABLE IF NOT EXISTS plans (
  plan_id     varchar(32)  PRIMARY KEY,
  features    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamp    NOT NULL DEFAULT now()
);

INSERT INTO plans (plan_id, features) VALUES
  ('free', '{
    "leveling": true,
    "tier_milestone_messages": true,
    "leveling_monthly_leaderboard": true,
    "xp_export": true,
    "rank_card_background_image": true,
    "role_rewards_limit": 50
  }'::jsonb)
ON CONFLICT (plan_id) DO NOTHING;

-- ── servers (one row per guild — for plan + Twitch wiring) ───
CREATE TABLE IF NOT EXISTS servers (
  server_id                          varchar(32) PRIMARY KEY,
  current_plan_id                    varchar(32) NOT NULL DEFAULT 'free' REFERENCES plans(plan_id),
  twitch_broadcaster_id              varchar(64),
  twitch_broadcaster_access_token    text,
  twitch_broadcaster_refresh_token   text,
  created_at                         timestamp   NOT NULL DEFAULT now()
);

-- ── server_features (per-server overrides) ───────────────
CREATE TABLE IF NOT EXISTS server_features (
  server_id    varchar(32) NOT NULL,
  feature_key  varchar(64) NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  limit_value  int,
  PRIMARY KEY (server_id, feature_key)
);

-- ── Drop the unused user_xp.last_voice_check_at column ───
ALTER TABLE user_xp DROP COLUMN IF EXISTS last_voice_check_at;

-- ── Twitch-ready fields on users (will be populated later) ───
-- The bot does not own a `users` table today; we create a minimal one
-- so the Twitch tokens have a home when /twitch link ships. nullable
-- so we don't have to touch it during MVP flows.
CREATE TABLE IF NOT EXISTS users (
  discord_id              varchar(32) PRIMARY KEY,
  twitch_id               varchar(64),
  twitch_username         varchar(64),
  twitch_access_token     text,
  twitch_refresh_token    text,
  created_at              timestamp   NOT NULL DEFAULT now()
);

-- ── Template-side leveling tables ─────────────────────────
-- All keyed on server_templates(id) ON DELETE CASCADE, so deleting a
-- template wipes its leveling rows automatically. Roles/channels are
-- stored by NAME (not Discord ID) — the install service maps them to
-- real IDs on the destination guild.

CREATE TABLE IF NOT EXISTS template_leveling_settings (
  template_id                 uuid PRIMARY KEY REFERENCES server_templates(id) ON DELETE CASCADE,
  enabled                     boolean      NOT NULL DEFAULT true,
  levelup_channel_name        varchar(128),
  levelup_channel_mode        varchar(16)  NOT NULL DEFAULT 'channel',
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

CREATE TABLE IF NOT EXISTS template_tiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  name            varchar(64) NOT NULL,
  emoji           varchar(64),
  icon_url        varchar(1024),
  start_level     int         NOT NULL,
  end_level       int         NOT NULL,
  color           varchar(16) NOT NULL DEFAULT '#8b5cf6',
  levelup_message text,
  sort_order      int         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS template_tiers_template_idx ON template_tiers (template_id);

CREATE TABLE IF NOT EXISTS template_role_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  level        int  NOT NULL,
  role_name    varchar(128) NOT NULL,
  CONSTRAINT template_role_rewards_uniq UNIQUE (template_id, level)
);
CREATE INDEX IF NOT EXISTS template_role_rewards_template_idx ON template_role_rewards (template_id);

CREATE TABLE IF NOT EXISTS template_no_xp_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id  uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  role_name    varchar(128) NOT NULL,
  CONSTRAINT template_no_xp_roles_uniq UNIQUE (template_id, role_name)
);

CREATE TABLE IF NOT EXISTS template_no_xp_channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  channel_name  varchar(128) NOT NULL,
  channel_type  varchar(8)   NOT NULL,
  CONSTRAINT template_no_xp_channels_uniq UNIQUE (template_id, channel_name, channel_type)
);

-- Opt-in flag on the parent template — lets owner-admin toggle whether
-- the leveling block participates in this template's deploy at all.
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS leveling_enabled boolean NOT NULL DEFAULT false;

COMMIT;
