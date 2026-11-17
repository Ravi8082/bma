-- 0017_evening_scheduler.sql
-- Per-shop evening summary scheduler: configured local send time and a once-per-day ledger.
ALTER TABLE app.shop_settings
  ADD COLUMN IF NOT EXISTS evening_summary_time text NOT NULL DEFAULT '18:30'
  CHECK (evening_summary_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- One row per shop per local day. The primary key is the idempotency key: the scheduler
-- claims the day before it creates the batch or queues the summary, in the same transaction.
CREATE TABLE IF NOT EXISTS app.evening_runs (
  shop_id     uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  run_date    date NOT NULL,
  batch_id    uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shop_id, run_date)
);

ALTER TABLE app.evening_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.evening_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY evening_runs_tenant_isolation ON app.evening_runs
  FOR ALL TO bma_app
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

GRANT SELECT, INSERT, UPDATE ON app.evening_runs TO bma_app;
