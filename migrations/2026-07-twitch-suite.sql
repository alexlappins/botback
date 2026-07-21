-- Twitch Suite (TZ-A/TZ-B): OAuth connections, Live Role, Event Alerts,
-- Schedule Sync, viewer links + Watch Time XP columns.
-- TypeORM synchronize creates all of this; the file documents the schema.

CREATE TABLE IF NOT EXISTS twitch_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id          varchar(32) NOT NULL,
  discord_user_id   varchar(32) NOT NULL,
  twitch_user_id    varchar(32) NOT NULL,
  twitch_login      varchar(64) NOT NULL,
  access_token_enc  text        NOT NULL,
  refresh_token_enc text        NOT NULL,
  scopes            text[]      NOT NULL DEFAULT '{}'::text[],
  status            varchar(16) NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twitch_connections_guild_idx ON twitch_connections (guild_id);

CREATE TABLE IF NOT EXISTS live_role_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    varchar(32) NOT NULL,
  role_id     varchar(32) NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  filter_text varchar(128),
  blacklist   text[] NOT NULL DEFAULT '{}'::text[],
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_role_configs_guild_idx ON live_role_configs (guild_id);

CREATE TABLE IF NOT EXISTS live_role_bindings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id       uuid        NOT NULL,
  guild_id        varchar(32) NOT NULL,
  discord_user_id varchar(32) NOT NULL,
  twitch_user_id  varchar(32) NOT NULL,
  twitch_login    varchar(64) NOT NULL,
  source          varchar(8)  NOT NULL DEFAULT 'manual',
  is_live         boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_role_bindings_guild_idx ON live_role_bindings (guild_id);
CREATE INDEX IF NOT EXISTS live_role_bindings_twitch_idx ON live_role_bindings (twitch_user_id);

CREATE TABLE IF NOT EXISTS event_alert_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    varchar(32) NOT NULL,
  event_type  varchar(16) NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  channel_id  varchar(32),
  format      varchar(8) NOT NULL DEFAULT 'text',
  template    text,
  card_config jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_alert_settings_guild_idx ON event_alert_settings (guild_id);

CREATE TABLE IF NOT EXISTS viewer_links (
  discord_user_id varchar(32) PRIMARY KEY,
  twitch_user_id  varchar(32) NOT NULL,
  twitch_login    varchar(64) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS viewer_links_twitch_idx ON viewer_links (twitch_user_id);

CREATE TABLE IF NOT EXISTS schedule_sync_settings (
  guild_id             varchar(32) PRIMARY KEY,
  enabled              boolean NOT NULL DEFAULT false,
  source_subs          text[] NOT NULL DEFAULT '{}'::text[],
  title_template       varchar(200),
  description_template text,
  cover_url            text,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schedule_sync_map (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id         varchar(32)  NOT NULL,
  segment_id       varchar(128) NOT NULL,
  discord_event_id varchar(32)  NOT NULL,
  fingerprint      varchar(64)  NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_sync_map_guild_idx ON schedule_sync_map (guild_id);

-- Watch Time XP (TZ-B §2.4)
ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS watch_minutes  bigint NOT NULL DEFAULT 0;
ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS watch_xp_today int    NOT NULL DEFAULT 0;
ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS watch_xp_day   varchar(10);

ALTER TABLE server_leveling_settings ADD COLUMN IF NOT EXISTS watch_xp_enabled   boolean NOT NULL DEFAULT false;
ALTER TABLE server_leveling_settings ADD COLUMN IF NOT EXISTS watch_xp_per_tick  int     NOT NULL DEFAULT 10;
ALTER TABLE server_leveling_settings ADD COLUMN IF NOT EXISTS watch_xp_daily_cap int     NOT NULL DEFAULT 600;

-- Role rewards: watch-hours condition (TZ-B §2.5)
ALTER TABLE role_rewards ADD COLUMN IF NOT EXISTS condition_type varchar(16) NOT NULL DEFAULT 'level';
ALTER TABLE role_rewards ADD COLUMN IF NOT EXISTS watch_hours    int;
