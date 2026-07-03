-- Premium subscription — per-guild, the single source of truth behind
-- PremiumService.isPremium(guildId) (Misha TZ v2.1, "ОБЩИЕ ПРИНЦИПЫ").
--
-- Принципы из ТЗ:
--   * Премиум проверяется ОДНОЙ функцией isPremium(guildId) — она читает
--     отсюда. Никаких хардкодов "if guildId === X".
--   * Данные пользователя НИКОГДА не удаляются при истечении подписки —
--     эта таблица хранит только статус биллинга, а настройки фич живут в
--     своих таблицах и сохраняются. Истёкшая подписка = active=false.
--
-- isPremium = active AND (current_period_end IS NULL OR current_period_end > now()).
-- `current_period_end = NULL` трактуется как бессрочный grant (ручная выдача
-- админом для теста/партнёрки); реальный провайдер будет проставлять дату.
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS guild_subscriptions (
  guild_id            varchar(32) PRIMARY KEY,
  active              boolean      NOT NULL DEFAULT false,
  plan                varchar(32)  NOT NULL DEFAULT 'premium',
  -- Billing linkage (filled by the payment provider webhook later).
  provider            varchar(32),
  external_id         varchar(128),
  current_period_end  timestamptz,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

-- Fast "is this guild's grant still valid" filter.
CREATE INDEX IF NOT EXISTS guild_subscriptions_active_idx
  ON guild_subscriptions (active, current_period_end);

COMMIT;
