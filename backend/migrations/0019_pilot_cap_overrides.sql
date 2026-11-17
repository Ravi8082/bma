-- 0019_pilot_cap_overrides.sql
--
-- Optional per-shop free-pilot ceilings. NULL means "use the platform default".
-- They are ceilings, never prices: reaching one switches the shop to the
-- deterministic parser and sends one polite notice. No payment request is ever made.

ALTER TABLE app.shop_settings
  ADD COLUMN IF NOT EXISTS pilot_daily_cap_paise bigint
    CHECK (pilot_daily_cap_paise IS NULL OR pilot_daily_cap_paise > 0);
ALTER TABLE app.shop_settings
  ADD COLUMN IF NOT EXISTS pilot_monthly_cap_paise bigint
    CHECK (pilot_monthly_cap_paise IS NULL OR pilot_monthly_cap_paise > 0);
