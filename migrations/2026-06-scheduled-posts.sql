-- Scheduled/recurring publication of message templates (Misha TZ v2.1 §2).
-- Premium-only at the API layer; rows persist through subscription expiry and
-- simply stop firing (checked at tick time), resuming on renewal.
--
-- kind:
--   'once'    → fire at next_run_at once, then status='done'
--   'daily'   → every day at time_of_day
--   'weekly'  → days_of_week (int[], 0=Sun..6=Sat) at time_of_day
--   'monthly' → day_of_month at time_of_day
-- Times are stored in UTC; the dashboard converts from the admin's timezone.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id       varchar(32) NOT NULL,
  channel_id     varchar(32) NOT NULL,
  -- Message payload snapshot (same shape as guild_messages fields).
  content        text,
  embed_json     jsonb,
  components_json jsonb,
  kind           varchar(16) NOT NULL,
  -- 'HH:MM' UTC for recurring kinds.
  time_of_day    varchar(5),
  days_of_week   int[],
  day_of_month   int,
  next_run_at    timestamptz,
  last_run_at    timestamptz,
  status         varchar(16) NOT NULL DEFAULT 'active',  -- active | paused | done
  run_count      int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduled_posts_guild_idx ON scheduled_posts (guild_id);
CREATE INDEX IF NOT EXISTS scheduled_posts_due_idx
  ON scheduled_posts (next_run_at) WHERE status = 'active';

COMMIT;
