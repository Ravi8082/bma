-- 0007_identity_rls_grants.sql
--
-- RLS and grants for Phase 2 identity tables. Every shop-owned table is
-- ENABLEd and FORCEd with a tenant policy. bma_app gets only the operations
-- it needs; no DDL, no TRUNCATE, no DELETE on financial/audit tables.

-- shop_settings
ALTER TABLE app.shop_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shop_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY shop_settings_tenant_isolation ON app.shop_settings
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- users
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant_isolation ON app.users
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- plans (reference data, no shop_id, no RLS)
-- subscriptions
ALTER TABLE app.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant_isolation ON app.subscriptions
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- consent_records
ALTER TABLE app.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consent_records FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_records_tenant_isolation ON app.consent_records
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- onboarding_state
ALTER TABLE app.onboarding_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.onboarding_state FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_state_tenant_isolation ON app.onboarding_state
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- phone_change_requests
ALTER TABLE app.phone_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.phone_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY phone_change_requests_tenant_isolation ON app.phone_change_requests
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- helper_assignments
ALTER TABLE app.helper_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.helper_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY helper_assignments_tenant_isolation ON app.helper_assignments
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- export_requests
ALTER TABLE app.export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.export_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY export_requests_tenant_isolation ON app.export_requests
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- deletion_requests
ALTER TABLE app.deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_tenant_isolation ON app.deletion_requests
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- feature_flags
ALTER TABLE app.feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.feature_flags FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flags_tenant_isolation ON app.feature_flags
  FOR ALL TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());

-- login_index: platform-level lookup for WhatsApp seller identification.
-- No RLS: this is a platform table, not shop-owned. Only the SECURITY DEFINER
-- function can read it; bma_app has no direct SELECT grant.
CREATE TABLE app.login_index (
  phone_bidx    bytea PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES app.shops(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  role          text NOT NULL CHECK (role IN ('OWNER', 'HELPER')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Keep login_index in sync with users.
CREATE OR REPLACE FUNCTION app.sync_login_index()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM app.login_index WHERE phone_bidx = OLD.phone_bidx;
    RETURN OLD;
  END IF;
  IF NEW.status = 'ACTIVE' THEN
    INSERT INTO app.login_index (phone_bidx, shop_id, user_id, role, updated_at)
    VALUES (NEW.phone_bidx, NEW.shop_id, NEW.id, NEW.role, now())
    ON CONFLICT (phone_bidx) DO UPDATE
      SET shop_id = EXCLUDED.shop_id,
          user_id = EXCLUDED.user_id,
          role = EXCLUDED.role,
          updated_at = EXCLUDED.updated_at;
  ELSE
    DELETE FROM app.login_index WHERE phone_bidx = NEW.phone_bidx;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_sync_login_index
  AFTER INSERT OR UPDATE OR DELETE ON app.users
  FOR EACH ROW
  EXECUTE FUNCTION app.sync_login_index();

-- SECURITY DEFINER: resolve seller by phone blind index.
-- Queries the platform login_index table (no RLS). Returns only shop_id, user_id, role.
CREATE OR REPLACE FUNCTION app.resolve_seller_by_phone(p_bidx bytea)
RETURNS TABLE (shop_id uuid, user_id uuid, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT li.shop_id, li.user_id, li.role
  FROM app.login_index li
  WHERE li.phone_bidx = p_bidx
  LIMIT 1;
$$;

COMMENT ON FUNCTION app.resolve_seller_by_phone(bytea) IS
  'Minimal lookup for WhatsApp seller identification. Returns shop_id, user_id, role only.';

REVOKE ALL ON FUNCTION app.resolve_seller_by_phone(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_seller_by_phone(bytea) TO bma_app;

-- Grants for bma_app on new tables.
GRANT SELECT, INSERT, UPDATE ON app.shop_settings TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.users TO bma_app;
GRANT SELECT ON app.plans TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.subscriptions TO bma_app;
GRANT SELECT, INSERT ON app.consent_records TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.onboarding_state TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.phone_change_requests TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.helper_assignments TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.export_requests TO bma_app;
GRANT SELECT, INSERT, UPDATE ON app.deletion_requests TO bma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.feature_flags TO bma_app;

-- Reporting role: read-only, column-restricted.
GRANT SELECT (shop_id, preset_key, language, timezone, visible_modules, default_report) ON app.shop_settings TO bma_reporting;
GRANT SELECT (id, shop_id, role, status, created_at) ON app.users TO bma_reporting;
GRANT SELECT (id, plan_key, name, trial_days, features) ON app.plans TO bma_reporting;
GRANT SELECT (shop_id, plan_id, status, trial_ends_at, current_period_start, current_period_end) ON app.subscriptions TO bma_reporting;
GRANT SELECT (shop_id, user_id, purpose, granted, policy_version, method, granted_at) ON app.consent_records TO bma_reporting;
GRANT SELECT (shop_id, state, language, preset_key, invalid_count, created_at, updated_at) ON app.onboarding_state TO bma_reporting;
GRANT SELECT (shop_id, flag_name, enabled, override) ON app.feature_flags TO bma_reporting;
GRANT EXECUTE ON FUNCTION app.resolve_seller_by_phone(bytea) TO bma_reporting;
