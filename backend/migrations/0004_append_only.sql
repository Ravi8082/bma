-- 0004_append_only.sql
--
-- Append-only protection for financial and audit records. Two layers:
--   1. RLS policies only allow scoped reads/writes;
--   2. triggers reject mutation, defence in depth for the same tenant boundary.

CREATE OR REPLACE FUNCTION app.reject_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Post a reversing entry instead of changing history.';
END;
$$;

CREATE OR REPLACE FUNCTION app.reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects TRUNCATE', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Financial ledger: money already lives here; it must never change.
CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON app.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON app.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON app.ledger_entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_truncate();

-- Audit trail: created, never rewritten.
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON app.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON app.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON app.audit_logs
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_truncate();

-- Security events are a permanent, append-only evidence trail.
CREATE TRIGGER security_events_no_update
  BEFORE UPDATE ON app.security_events
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER security_events_no_delete
  BEFORE DELETE ON app.security_events
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_row_mutation();

CREATE TRIGGER security_events_no_truncate
  BEFORE TRUNCATE ON app.security_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION app.reject_truncate();
