-- 0005_grants.sql
--
-- Privileges. The migrator owns the schema (bootstrap); the API and reporting roles receive
-- exactly what they need and nothing more.

REVOKE ALL ON DATABASE business_memory FROM PUBLIC;
GRANT CONNECT ON DATABASE business_memory TO bma_migrator, bma_app, bma_reporting;

REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE CREATE ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO bma_migrator, bma_app, bma_reporting;

-- Runtime role: exactly the operations Phase 1 needs. No DDL, no TRUNCATE, no DELETE on
-- financial or audit tables, no superuser, no BYPASSRLS (enforced by connectDb()).
GRANT SELECT, INSERT, UPDATE ON app.shops TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.customers TO bma_app;
GRANT SELECT, INSERT ON app.ledger_entries TO bma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.whatsapp_messages TO bma_app;
GRANT SELECT, INSERT, DELETE ON app.idempotency_keys TO bma_app;
GRANT SELECT, INSERT ON app.audit_logs TO bma_app;
GRANT INSERT ON app.security_events TO bma_app;

-- Reporting role: read-only, column-restricted, tenant-scoped via the same RLS. Without a
-- tenant context it sees zero rows (fail closed).
GRANT SELECT (id, shop_id, customer_id, posting_id, entry_seq, entry_type, direction, amount_paise, currency, occurred_at, source, source_id, reverses_entry_id, created_at) ON app.ledger_entries TO bma_reporting;
GRANT SELECT (id, name, status, created_at, updated_at, version) ON app.shops TO bma_reporting;
GRANT SELECT (id, occurred_at, event_type, severity, actor_ref, detail, created_at) ON app.security_events TO bma_reporting;
