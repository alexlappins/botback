-- Shop v2 (Misha's TZ-1/TZ-2): real Stripe payments, product lifecycle,
-- deploy tracking, install attempts. Idempotent: safe to re-run.

BEGIN;

-- ── products (store_templates) ──────────────────────────────
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS slug varchar(128);
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS name varchar(128);
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS old_price int;
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'draft';
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS short_description text;
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS cover_image_url text;

-- Backfill: previously-active rows were the published catalogue.
UPDATE store_templates SET status = 'published' WHERE "isActive" = true AND status = 'draft';

-- Backfill slugs from the linked template name (lowercase, dashes), suffixing
-- the row id to guarantee uniqueness.
UPDATE store_templates st
SET slug = regexp_replace(lower(coalesce(st.name, t.name)), '[^a-z0-9]+', '-', 'g')
           || '-' || left(st.id::text, 6)
FROM server_templates t
WHERE t.id = st.template_id AND st.slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS store_templates_slug_uq ON store_templates (slug);

-- ── purchases ───────────────────────────────────────────────
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS product_id uuid;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deployed_guild_id varchar(32);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS deployed_at timestamptz;

UPDATE purchases p
SET product_id = st.id
FROM store_templates st
WHERE st.template_id = p.template_id AND p.product_id IS NULL;

-- ── pending_installs (TZ-2 §3) ──────────────────────────────
CREATE TABLE IF NOT EXISTS pending_installs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id      uuid         NOT NULL,
  discord_user_id  varchar(32)  NOT NULL,
  status           varchar(24)  NOT NULL DEFAULT 'waiting_server',
  guild_id         varchar(32),
  progress         varchar(32),
  error            text,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_installs_user_idx
  ON pending_installs (discord_user_id, status);

COMMIT;
