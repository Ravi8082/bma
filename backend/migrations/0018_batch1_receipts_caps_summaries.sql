-- 0018_batch1_receipts_caps_summaries.sql
--
-- Batch 1: itemised receipts, free-pilot cap notices, and due-shop discovery that
-- does not need a tenant context.
--
-- Money stays integer paise. The new projection table carries no financial data;
-- it exists only because app.shop_settings is FORCE RLS and therefore cannot be
-- read by a SECURITY DEFINER function owned by the table owner either.

-- Itemised receipts. The backend computes each line total from integer quantity
-- and unit price; the stored array is display input, never a money authority.
ALTER TABLE app.entry_drafts
  ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE app.entry_drafts
  ADD CONSTRAINT entry_drafts_items_is_array CHECK (jsonb_typeof(items) = 'array');

-- At most one polite free-pilot cap notice per shop per period. The period is
-- 'YYYY-MM-DD' for the daily cap and 'YYYY-MM' for the monthly cap.
CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_logs_pilot_cap_notice
  ON app.audit_logs (shop_id, (after->>'period'))
  WHERE action = 'PILOT_CAP_NOTICE';

-- Platform projection of the evening schedule. Not shop-owned data, not writable
-- by bma_app, and carries only the two values the scheduler must know before it
-- can open a tenant transaction.
CREATE TABLE IF NOT EXISTS app.evening_schedule (
  shop_id              uuid PRIMARY KEY REFERENCES app.shops(id) ON DELETE CASCADE,
  timezone             text NOT NULL,
  evening_summary_time text NOT NULL
    CHECK (evening_summary_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION app.sync_evening_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  INSERT INTO app.evening_schedule (shop_id, timezone, evening_summary_time, updated_at)
  VALUES (NEW.shop_id, NEW.timezone, NEW.evening_summary_time, now())
  ON CONFLICT (shop_id) DO UPDATE
    SET timezone = EXCLUDED.timezone,
        evening_summary_time = EXCLUDED.evening_summary_time,
        updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.sync_evening_schedule() FROM PUBLIC;

DROP TRIGGER IF EXISTS shop_settings_evening_schedule ON app.shop_settings;
CREATE TRIGGER shop_settings_evening_schedule
  AFTER INSERT OR UPDATE OF timezone, evening_summary_time ON app.shop_settings
  FOR EACH ROW EXECUTE FUNCTION app.sync_evening_schedule();

-- One-time backfill. Migrations run as the table owner, and FORCE RLS makes even
-- the owner subject to the tenant policy. Relax it for this copy-only statement
-- and restore it immediately in the same migration transaction.
ALTER TABLE app.shop_settings NO FORCE ROW LEVEL SECURITY;
INSERT INTO app.evening_schedule (shop_id, timezone, evening_summary_time)
SELECT shop_id, timezone, evening_summary_time FROM app.shop_settings
ON CONFLICT (shop_id) DO UPDATE
  SET timezone = EXCLUDED.timezone,
      evening_summary_time = EXCLUDED.evening_summary_time,
      updated_at = now();
ALTER TABLE app.shop_settings FORCE ROW LEVEL SECURITY;

-- Returns identifiers only. No tenant context, no shop name, no phone, no money.
CREATE OR REPLACE FUNCTION app.list_due_shop_ids(p_now timestamptz)
RETURNS TABLE (shop_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT s.shop_id
  FROM app.evening_schedule s
  WHERE (
    EXTRACT(HOUR FROM (p_now AT TIME ZONE s.timezone)) * 60
    + EXTRACT(MINUTE FROM (p_now AT TIME ZONE s.timezone))
  ) >= (
    EXTRACT(HOUR FROM s.evening_summary_time::time) * 60
    + EXTRACT(MINUTE FROM s.evening_summary_time::time)
  );
$$;

REVOKE ALL ON FUNCTION app.list_due_shop_ids(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_due_shop_ids(timestamptz) TO bma_app;

REVOKE ALL ON app.evening_schedule FROM PUBLIC;
