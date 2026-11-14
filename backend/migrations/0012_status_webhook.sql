-- 0012_status_webhook.sql
--
-- Phase 3 Task A: correlate Meta status webhooks with an outbound message.
--
-- `outbox_events` is FORCE RLS, so a cross-tenant lookup by provider_message_id
-- cannot run as bma_app. A platform-level index (no RLS, like inbox_messages and
-- login_index) maps the provider message id to its shop. It is populated by
-- markSent() in the same transaction as the outbox state change.
--
CREATE TABLE IF NOT EXISTS app.provider_message_index (
  provider_message_id text PRIMARY KEY CHECK (length(provider_message_id) BETWEEN 1 AND 200),
  shop_id             uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  outbox_id           uuid NOT NULL REFERENCES app.outbox_events(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_provider_message_index_shop
  ON app.provider_message_index (shop_id);

GRANT SELECT, INSERT ON app.provider_message_index TO bma_app;
GRANT SELECT ON app.provider_message_index TO bma_reporting;
