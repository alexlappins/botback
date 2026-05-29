-- Store: richer product cards.
--
-- Adds fields a real storefront needs (vs. the bare price+icon MVP):
--   - long_description: full markdown body for the product detail page
--   - category: top-level shelf the product lives on
--                  (gaming | community | anime | crypto | streaming | other)
--   - tags:        free-form labels for filters; multi-tag per product
--   - screenshots: array of image URLs uploaded via /api/uploads
--   - featured + featured_order: hero slot on the store homepage
--
-- Idempotent. Apply with:
--   psql "$DATABASE_URL" -f migrations/2026-05-store-rich-cards.sql

BEGIN;

ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS long_description text;
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS category        varchar(32);
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS tags            text[]      NOT NULL DEFAULT '{}';
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS screenshots     text[]      NOT NULL DEFAULT '{}';
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS featured        boolean     NOT NULL DEFAULT false;
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS featured_order  int         NOT NULL DEFAULT 0;
-- For the "Popular" sort. Bumped on each successful checkout; cheap proxy until
-- we add a real purchase-count materialised view.
ALTER TABLE store_templates ADD COLUMN IF NOT EXISTS purchase_count  int         NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS store_templates_category_idx ON store_templates (category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS store_templates_featured_idx ON store_templates (featured, featured_order) WHERE featured;
CREATE INDEX IF NOT EXISTS store_templates_tags_idx     ON store_templates USING gin (tags);

COMMIT;
