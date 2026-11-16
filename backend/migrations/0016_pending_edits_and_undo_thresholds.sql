-- 0016_pending_edits_and_undo_thresholds.sql
CREATE TABLE IF NOT EXISTS app.pending_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES app.entry_drafts(id) ON DELETE CASCADE,
  field text NOT NULL CHECK (field IN ('name','amount','type')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.pending_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pending_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY pending_edits_tenant_isolation ON app.pending_edits
  FOR ALL TO bma_app USING (shop_id = app.current_shop_id()) WITH CHECK (shop_id = app.current_shop_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON app.pending_edits TO bma_app;

ALTER TABLE app.shop_settings ADD COLUMN IF NOT EXISTS undo_extra_confirm_age_ms integer NOT NULL DEFAULT 86400000;
ALTER TABLE app.shop_settings ADD COLUMN IF NOT EXISTS undo_extra_confirm_amount_paise bigint NOT NULL DEFAULT 1000000;
ALTER TABLE app.shop_settings ADD COLUMN IF NOT EXISTS undo_edit_enabled boolean NOT NULL DEFAULT false;