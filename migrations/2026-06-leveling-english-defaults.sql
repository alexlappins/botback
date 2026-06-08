-- Leveling defaults — switch from Russian to English.
--
-- Two things:
--   1) Drop the old Russian DEFAULT on `levelup_message_template` and
--      replace it with an English one. Affects only future INSERTs that
--      omit the column (e.g. seeding a new guild's settings row).
--   2) For rows that *currently* still hold the old Russian default verbatim
--      (i.e. admins haven't customised them), rewrite to the English string.
--      Customised values are left untouched.
--
-- Applies to both per-guild and template-level settings.
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE server_leveling_settings
  ALTER COLUMN levelup_message_template
  SET DEFAULT 'GG {user}! You hit level {level}!';

UPDATE server_leveling_settings
SET levelup_message_template = 'GG {user}! You hit level {level}!'
WHERE levelup_message_template = 'GG {user}! Ты достиг уровня {level}!';

-- template_leveling_settings is created only after iteration-2; guard so this
-- migration also applies cleanly on environments still on the original schema.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'template_leveling_settings'
  ) THEN
    EXECUTE 'ALTER TABLE template_leveling_settings
      ALTER COLUMN levelup_message_template
      SET DEFAULT ''GG {user}! You hit level {level}!''';

    EXECUTE 'UPDATE template_leveling_settings
      SET levelup_message_template = ''GG {user}! You hit level {level}!''
      WHERE levelup_message_template = ''GG {user}! Ты достиг уровня {level}!''';
  END IF;
END$$;

COMMIT;
