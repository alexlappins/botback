-- Security Suite (Security TZ). TypeORM synchronize creates these tables
-- automatically; this file documents the schema for clean environments.
-- Idempotent.

CREATE TABLE IF NOT EXISTS security_settings (
  guild_id                  varchar(32) PRIMARY KEY,
  preset                    varchar(16),
  age_filter_enabled        boolean NOT NULL DEFAULT false,
  age_filter_min_days       int     NOT NULL DEFAULT 7,
  age_filter_action         varchar(16) NOT NULL DEFAULT 'alert',
  age_filter_kick_message   text,
  panic_slowmode_enabled    boolean NOT NULL DEFAULT false,
  panic_slowmode_seconds    int     NOT NULL DEFAULT 30,
  panel_channel_id          varchar(32),
  panel_message_id          varchar(32),
  anti_raid_action          varchar(16) NOT NULL DEFAULT 'alert',
  anti_raid_auto_panic      boolean NOT NULL DEFAULT false,
  anti_nuke_action          varchar(16) NOT NULL DEFAULT 'alert',
  quarantine_role_id        varchar(32),
  quarantine_channel_id     varchar(32),
  shield_enabled            boolean NOT NULL DEFAULT false,
  shield_post_announcements boolean NOT NULL DEFAULT true,
  shield_channel_id         varchar(32),
  shield_trigger_subs       text[] NOT NULL DEFAULT '{}'::text[],
  shield_slowmode_enabled   boolean NOT NULL DEFAULT false,
  shield_slowmode_seconds   int     NOT NULL DEFAULT 10,
  shield_slowmode_channels  text[] NOT NULL DEFAULT '{}'::text[],
  shield_age_filter_enabled boolean NOT NULL DEFAULT false,
  shield_age_filter_days    int     NOT NULL DEFAULT 14,
  shield_embed_on           jsonb,
  shield_embed_off          jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_whitelist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    varchar(32) NOT NULL,
  entity_type varchar(8)  NOT NULL,
  entity_id   varchar(32) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_whitelist_guild_idx ON security_whitelist (guild_id);

CREATE TABLE IF NOT EXISTS panic_state (
  guild_id     varchar(32) PRIMARY KEY,
  saved_state  jsonb       NOT NULL,
  activated_by varchar(32) NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quarantine_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id          varchar(32) NOT NULL,
  user_id           varchar(32) NOT NULL,
  original_role_ids text[] NOT NULL DEFAULT '{}'::text[],
  reason            text,
  source            varchar(24) NOT NULL DEFAULT 'manual',
  status            varchar(16) NOT NULL DEFAULT 'active',
  review_message_id varchar(32),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quarantine_records_guild_user_idx ON quarantine_records (guild_id, user_id);

CREATE TABLE IF NOT EXISTS nuke_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id          varchar(32) NOT NULL,
  user_id           varchar(32) NOT NULL,
  stripped_role_ids text[] NOT NULL DEFAULT '{}'::text[],
  detector          varchar(8) NOT NULL,
  restored          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nuke_incidents_guild_idx ON nuke_incidents (guild_id, created_at);

-- §10 Snapshot & Restore
CREATE TABLE IF NOT EXISTS snapshots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id   varchar(32) NOT NULL,
  data       jsonb       NOT NULL,
  type       varchar(8)  NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS snapshots_guild_idx ON snapshots (guild_id, created_at);
