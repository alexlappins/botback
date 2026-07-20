-- Shop prices move from whole dollars to CENTS (integer) — shop TZ §3.
-- $99 stored as 9900; $99.99 as 9999. Float is never used, so no rounding
-- drift. Existing whole-dollar rows are multiplied by 100 exactly once —
-- the flag table makes this migration safe to re-run.

CREATE TABLE IF NOT EXISTS schema_flags (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'shop_price_cents') THEN
    UPDATE store_templates SET price = price * 100;
    UPDATE store_templates SET old_price = old_price * 100 WHERE old_price IS NOT NULL;
    UPDATE purchases SET amount = amount * 100;
    INSERT INTO schema_flags (name) VALUES ('shop_price_cents');
  END IF;
END$$;
