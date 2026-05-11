-- Welcome/Goodbye system: variants refactor + owner-admin templates.
--
-- Iteration 3 changes:
--   1. welcome_templates + goodbye_templates gain per-variant image/buttons
--      fields. welcome_templates also gets a `role` column to separate the
--      new_member and returning_member pools.
--   2. welcome_configs / goodbye_configs lose image-level columns
--      (they're now per-variant) and welcome_configs loses returning_member_text
--      (replaced by returning_member variants). Old columns are KEPT for safety
--      and ignored by the new code path; drop manually after migrating data.
--   3. server_templates gets welcome_*/goodbye_* columns.
--   4. New tables template_welcome_variants + template_goodbye_variants store
--      template-level welcome/goodbye variants for the owner-admin.
--
-- Idempotent: safe to re-run. Apply with:
--   psql "$DATABASE_URL" -f migrations/2026-05-variants-and-templates.sql

BEGIN;

-- ─── Per-variant fields on welcome_templates ─────────────
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS role                 varchar(24) NOT NULL DEFAULT 'new_member';
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS image_enabled        boolean     NOT NULL DEFAULT false;
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS image_send_mode      varchar(16) NOT NULL DEFAULT 'with_text';
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS background_image_url varchar(1024);
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS background_fill      varchar(16);
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS avatar_config        jsonb;
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS username_config      jsonb;
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS image_text_config    jsonb;
ALTER TABLE welcome_templates ADD COLUMN IF NOT EXISTS buttons_config       jsonb;

-- One-time backfill: copy parent welcome_configs image/buttons fields onto each
-- existing welcome_template row so behaviour stays unchanged after the upgrade.
-- Only runs when the welcome_configs columns still exist (i.e. first run).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'welcome_configs' AND column_name = 'image_enabled'
  ) THEN
    UPDATE welcome_templates wt
    SET image_enabled        = COALESCE(wt.image_enabled, wc.image_enabled),
        image_send_mode      = COALESCE(NULLIF(wt.image_send_mode, ''), wc.image_send_mode),
        background_image_url = COALESCE(wt.background_image_url, wc.background_image_url),
        background_fill      = COALESCE(wt.background_fill, wc.background_fill),
        avatar_config        = COALESCE(wt.avatar_config, wc.avatar_config),
        username_config      = COALESCE(wt.username_config, wc.username_config),
        image_text_config    = COALESCE(wt.image_text_config, wc.image_text_config),
        buttons_config       = COALESCE(wt.buttons_config, wc.buttons_config)
    FROM welcome_configs wc
    WHERE wt.config_id = wc.id;

    -- Backfill returning_member variant from returning_member_text if set
    INSERT INTO welcome_templates (config_id, role, text, order_index)
    SELECT id, 'returning_member', returning_member_text, 0
    FROM welcome_configs
    WHERE returning_member_text IS NOT NULL
      AND returning_member_text <> ''
      AND NOT EXISTS (
        SELECT 1 FROM welcome_templates wt2
        WHERE wt2.config_id = welcome_configs.id AND wt2.role = 'returning_member'
      );
  END IF;
END$$;

-- ─── Per-variant fields on goodbye_templates ─────────────
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS image_enabled        boolean     NOT NULL DEFAULT false;
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS image_send_mode      varchar(16) NOT NULL DEFAULT 'with_text';
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS background_image_url varchar(1024);
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS background_fill      varchar(16);
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS avatar_config        jsonb;
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS username_config      jsonb;
ALTER TABLE goodbye_templates ADD COLUMN IF NOT EXISTS image_text_config    jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'goodbye_configs' AND column_name = 'image_enabled'
  ) THEN
    UPDATE goodbye_templates gt
    SET image_enabled        = COALESCE(gt.image_enabled, gc.image_enabled),
        image_send_mode      = COALESCE(NULLIF(gt.image_send_mode, ''), gc.image_send_mode),
        background_image_url = COALESCE(gt.background_image_url, gc.background_image_url),
        background_fill      = COALESCE(gt.background_fill, gc.background_fill),
        avatar_config        = COALESCE(gt.avatar_config, gc.avatar_config),
        username_config      = COALESCE(gt.username_config, gc.username_config),
        image_text_config    = COALESCE(gt.image_text_config, gc.image_text_config)
    FROM goodbye_configs gc
    WHERE gt.config_id = gc.id;
  END IF;
END$$;

-- ─── server_templates: welcome/goodbye config columns ────
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS welcome_enabled            boolean     NOT NULL DEFAULT false;
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS welcome_send_mode          varchar(16) NOT NULL DEFAULT 'channel';
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS welcome_channel_name       varchar(128);
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS welcome_returning_enabled  boolean     NOT NULL DEFAULT false;
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS goodbye_enabled            boolean     NOT NULL DEFAULT false;
ALTER TABLE server_templates ADD COLUMN IF NOT EXISTS goodbye_channel_name       varchar(128);

-- ─── template_welcome_variants ───────────────────────────
CREATE TABLE IF NOT EXISTS template_welcome_variants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  role                 varchar(24) NOT NULL DEFAULT 'new_member',
  text                 text NOT NULL,
  order_index          int NOT NULL DEFAULT 0,
  image_enabled        boolean NOT NULL DEFAULT false,
  image_send_mode      varchar(16) NOT NULL DEFAULT 'with_text',
  background_image_url varchar(1024),
  background_fill      varchar(16),
  avatar_config        jsonb,
  username_config      jsonb,
  image_text_config    jsonb,
  buttons_config       jsonb
);
CREATE INDEX IF NOT EXISTS template_welcome_variants_template_idx
  ON template_welcome_variants (template_id);

-- ─── template_goodbye_variants ───────────────────────────
CREATE TABLE IF NOT EXISTS template_goodbye_variants (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid NOT NULL REFERENCES server_templates(id) ON DELETE CASCADE,
  text                 text NOT NULL,
  order_index          int NOT NULL DEFAULT 0,
  image_enabled        boolean NOT NULL DEFAULT false,
  image_send_mode      varchar(16) NOT NULL DEFAULT 'with_text',
  background_image_url varchar(1024),
  background_fill      varchar(16),
  avatar_config        jsonb,
  username_config      jsonb,
  image_text_config    jsonb
);
CREATE INDEX IF NOT EXISTS template_goodbye_variants_template_idx
  ON template_goodbye_variants (template_id);

COMMIT;

-- Optional cleanup once the new code is in production and you confirmed the
-- backfill worked. The new TypeORM entities don't have these columns, so
-- synchronize: true with strict mode would drop them anyway. Keep them around
-- a release or two for rollback safety:
--
--   ALTER TABLE welcome_configs DROP COLUMN image_enabled;
--   ALTER TABLE welcome_configs DROP COLUMN image_send_mode;
--   ALTER TABLE welcome_configs DROP COLUMN background_image_url;
--   ALTER TABLE welcome_configs DROP COLUMN background_fill;
--   ALTER TABLE welcome_configs DROP COLUMN avatar_config;
--   ALTER TABLE welcome_configs DROP COLUMN username_config;
--   ALTER TABLE welcome_configs DROP COLUMN image_text_config;
--   ALTER TABLE welcome_configs DROP COLUMN buttons_config;
--   ALTER TABLE welcome_configs DROP COLUMN returning_member_text;
--   ALTER TABLE goodbye_configs DROP COLUMN image_enabled;
--   ALTER TABLE goodbye_configs DROP COLUMN image_send_mode;
--   ALTER TABLE goodbye_configs DROP COLUMN background_image_url;
--   ALTER TABLE goodbye_configs DROP COLUMN background_fill;
--   ALTER TABLE goodbye_configs DROP COLUMN avatar_config;
--   ALTER TABLE goodbye_configs DROP COLUMN username_config;
--   ALTER TABLE goodbye_configs DROP COLUMN image_text_config;
