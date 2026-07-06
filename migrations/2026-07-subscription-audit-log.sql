-- Owner-admin manual subscription management (Misha's TZ §15).
-- Append-only audit trail of grant/cancel operations.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS subscription_audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action         varchar(16)  NOT NULL,
  guild_id       varchar(32)  NOT NULL,
  guild_name     varchar(256),
  admin_id       varchar(32)  NOT NULL,
  admin_name     varchar(128),
  duration_days  int,
  reason         text,
  source         varchar(32),
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_audit_log_guild_idx
  ON subscription_audit_log (guild_id);

-- Mark existing Stripe-managed rows explicitly; anything the webhook touched
-- has provider set already, but older manual toggles may have NULL.
UPDATE guild_subscriptions SET provider = 'manual' WHERE provider IS NULL;
