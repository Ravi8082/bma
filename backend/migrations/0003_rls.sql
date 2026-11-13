-- 0003_rls.sql
--
-- Row-level security. Every shop-owned table is ENABLEd and FORCEd (FORCE applies to the
-- table owner too, so even the migrator is subject to it), and carries a tenant policy that
-- compares shop_id (or id for the shop root) with the transaction-local setting written by
-- withTenant(). No shop context means no rows and no writes: fail closed.

ALTER TABLE app.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shops FORCE ROW LEVEL SECURITY;
CREATE POLICY shops_tenant_isolation ON app.shops
  FOR ALL
  TO bma_app, bma_reporting
  USING (id = app.current_shop_id())
  WITH CHECK (id = app.current_shop_id());

ALTER TABLE app.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_tenant_isolation ON app.customers
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_entries_tenant_isolation ON app.ledger_entries
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.whatsapp_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_messages_tenant_isolation ON app.whatsapp_messages
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_tenant_isolation ON app.idempotency_keys
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

ALTER TABLE app.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_logs_tenant_isolation ON app.audit_logs
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- security_events is platform-level, not shop-owned: it carries no shop_id and no financial
-- data, so it intentionally has no RLS policy. Writes are INSERT-only for bma_app, reads are
-- reserved for the reporting role.
