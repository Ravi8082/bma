-- 0014_type_unclear_inline_phone_and_multi.sql
-- Phase 4 hardening: persist type_unclear flag, inline customer phone, and per-entry index on drafts.

ALTER TABLE app.entry_drafts ADD COLUMN IF NOT EXISTS type_unclear boolean NOT NULL DEFAULT false;
ALTER TABLE app.entry_drafts ADD COLUMN IF NOT EXISTS customer_phone_enc bytea;
ALTER TABLE app.entry_drafts ADD COLUMN IF NOT EXISTS customer_phone_bidx bytea;
ALTER TABLE app.entry_drafts ADD COLUMN IF NOT EXISTS entry_index smallint NOT NULL DEFAULT 0;

-- Allow multiple drafts per source message (one per independent entry).
ALTER TABLE app.entry_drafts DROP CONSTRAINT IF EXISTS entry_drafts_shop_source_unique;
ALTER TABLE app.entry_drafts ADD CONSTRAINT entry_drafts_shop_source_idx_unique UNIQUE (shop_id, source_message_id, entry_index);

GRANT SELECT, INSERT, UPDATE ON app.entry_drafts TO bma_app;
