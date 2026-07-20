-- Server Logs 2.0 + Server Alerts (Misha's TZ). TypeORM synchronize creates
-- these tables automatically; this file documents the schema and makes clean
-- environments reproducible. Idempotent.
--
-- NOTE (TZ §8): migration of EXISTING per-event settings happens in code at
-- boot (LogSettingsService.migrateLegacy) because the legacy store is the
-- data/guilds.json file, not Postgres.

CREATE TABLE IF NOT EXISTS log_settings (
  guild_id               varchar(32) PRIMARY KEY,
  single_channel_mode    boolean NOT NULL DEFAULT false,
  single_channel_id      varchar(32),
  ban_enabled            boolean NOT NULL DEFAULT false,
  ban_channel_id         varchar(32),
  join_leave_enabled     boolean NOT NULL DEFAULT false,
  join_leave_channel_id  varchar(32),
  messages_enabled       boolean NOT NULL DEFAULT false,
  messages_channel_id    varchar(32),
  moderation_enabled     boolean NOT NULL DEFAULT false,
  moderation_channel_id  varchar(32),
  channel_enabled        boolean NOT NULL DEFAULT false,
  channel_channel_id     varchar(32),
  server_enabled         boolean NOT NULL DEFAULT false,
  server_channel_id      varchar(32),
  voice_enabled          boolean NOT NULL DEFAULT false,
  voice_channel_id       varchar(32),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_settings (
  guild_id   varchar(32) PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT false,
  recipients text[] NOT NULL DEFAULT '{}'::text[],
  d1_enabled boolean NOT NULL DEFAULT true,
  d2_enabled boolean NOT NULL DEFAULT true,
  d3_enabled boolean NOT NULL DEFAULT true,
  d4_enabled boolean NOT NULL DEFAULT true,
  d5_enabled boolean NOT NULL DEFAULT true,
  d6_enabled boolean NOT NULL DEFAULT true,
  d7_enabled boolean NOT NULL DEFAULT true,
  d8_enabled boolean NOT NULL DEFAULT true,
  d9_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id      varchar(32) NOT NULL,
  detector      varchar(8)  NOT NULL,
  severity      varchar(16) NOT NULL,
  summary       text        NOT NULL,
  actor_user_id varchar(32),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_log_guild_detector_idx
  ON alert_log (guild_id, detector, created_at);
