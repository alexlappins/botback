-- Bot Personalization via Discord webhooks (Misha TZ v2.1 §8).
-- Premium-only at runtime; settings persist through expiry (messages just go
-- back to the plain bot identity) and re-apply on renewal.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS bot_personalization (
  guild_id           varchar(32) PRIMARY KEY,
  enabled            boolean      NOT NULL DEFAULT false,
  custom_name        varchar(32),
  custom_avatar_url  text,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now()
);

-- Cache of bot-owned webhooks per channel (TZ §8.6). One service webhook per
-- channel, reused across sends; recreated when Discord reports it deleted.
CREATE TABLE IF NOT EXISTS webhook_cache (
  guild_id    varchar(32) NOT NULL,
  channel_id  varchar(32) NOT NULL,
  webhook_id  varchar(32) NOT NULL,
  webhook_url text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);

COMMIT;
