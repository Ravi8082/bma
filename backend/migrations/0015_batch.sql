-- 0015_batch.sql
-- Phase 4 evening batch: snapshot of drafts under a batch id.
ALTER TABLE app.entry_drafts ADD COLUMN IF NOT EXISTS batch_id uuid;
CREATE INDEX IF NOT EXISTS ix_entry_drafts_batch ON app.entry_drafts (shop_id, batch_id);

GRANT SELECT, INSERT, UPDATE ON app.entry_drafts TO bma_app;