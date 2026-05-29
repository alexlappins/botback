-- Twitch (and future YouTube/Kick/TikTok) Live notifications — Iteration 1.
--
-- One polymorphic table for all platforms — `platform` discriminator
-- + `platform_user_id`/`platform_username` are platform-specific. Adding
-- a new platform later is "INSERT INTO ... VALUES ('youtube', ...)" plus
-- a new StreamProvider implementation; no schema migration needed.
--
-- `embed_config jsonb DEFAULT '{}'` is here from day 1 even though the
-- Phase 1 release uses only the default renderer — so the editor (Phase 2)
-- doesn't require another migration.
--
-- Idempotent. Apply with:
--   psql "$DATABASE_URL" -f migrations/2026-05-twitch-eventsub.sql

BEGIN;

CREATE TABLE IF NOT EXISTS stream_subscriptions (
  id                          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id                    varchar(32)  NOT NULL,
  discord_channel_id          varchar(32)  NOT NULL,
  platform                    varchar(16)  NOT NULL,
  platform_user_id            varchar(64)  NOT NULL,
  platform_username           varchar(128) NOT NULL,
  enabled                     boolean      NOT NULL DEFAULT true,
  is_live                     boolean      NOT NULL DEFAULT false,
  current_stream_id           varchar(64),
  current_stream_started_at   timestamp,
  content_template            text,
  embed_config                jsonb        NOT NULL DEFAULT '{}'::jsonb,
  last_notified_at            timestamp,
  created_at                  timestamp    NOT NULL DEFAULT now(),
  updated_at                  timestamp    NOT NULL DEFAULT now(),
  CONSTRAINT stream_subs_guild_platform_user_uniq
    UNIQUE (guild_id, platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS stream_subs_guild_idx          ON stream_subscriptions (guild_id);
CREATE INDEX IF NOT EXISTS stream_subs_platform_user_idx  ON stream_subscriptions (platform, platform_user_id);
CREATE INDEX IF NOT EXISTS stream_subs_enabled_idx        ON stream_subscriptions (enabled);

-- Mapping kept across restarts so we don't lose track of which EventSub
-- subscriptions belong to which (guild, channel). The WS session_id is
-- transient (new on every connect), so we DON'T persist it; we re-create
-- subscriptions on each fresh session_welcome.
--
-- platform_subscription_id is the Twitch EventSub subscription id (or
-- analogous id for future platforms). NULL while we're in the middle of
-- creating/recreating.
CREATE TABLE IF NOT EXISTS platform_event_subscriptions (
  id                        uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_subscription_id    uuid         NOT NULL REFERENCES stream_subscriptions(id) ON DELETE CASCADE,
  platform                  varchar(16)  NOT NULL,
  event_type                varchar(64)  NOT NULL,
  platform_subscription_id  varchar(64),
  created_at                timestamp    NOT NULL DEFAULT now(),
  CONSTRAINT platform_event_subs_uniq
    UNIQUE (stream_subscription_id, event_type)
);
CREATE INDEX IF NOT EXISTS platform_event_subs_stream_idx
  ON platform_event_subscriptions (stream_subscription_id);

COMMIT;
