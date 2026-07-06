-- Welcome/returning/goodbye example texts — switch from Russian to English.
--
-- The old Russian example strings were seeded from the dashboard defaults.
-- Rows that still hold them verbatim (admins haven't customised) are
-- rewritten to the English defaults now used by the UI. Customised texts are
-- left untouched. Idempotent: safe to re-run.

BEGIN;

UPDATE welcome_templates
SET text = 'Hey {user}! Welcome to **{server.name}** 🎉'
WHERE text = 'Привет, {user}! Добро пожаловать на **{server.name}** 🎉';

UPDATE welcome_templates
SET text = 'Welcome back, {user}!'
WHERE text = 'С возвращением, {user}!';

UPDATE goodbye_templates
SET text = '{user.name} has left **{server.name}**. We are now {server.memberCount}.'
WHERE text = '{user.name} покинул(а) **{server.name}**. Нас стало {server.memberCount}.';

COMMIT;
