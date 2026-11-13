-- 0001_schema.sql
--
-- Schema, tenant helper and trigger functions. Forward-only: edit a new migration.
-- gen_random_uuid() is built into PostgreSQL 13+, so no extension is required and the
-- migrator role does not need superuser to install one.

CREATE SCHEMA IF NOT EXISTS app;

REVOKE ALL ON SCHEMA app FROM PUBLIC;

COMMENT ON SCHEMA app IS
  'Application schema. Every shop-owned table is protected by FORCE ROW LEVEL SECURITY.';

/**
 * The tenant key read by every RLS policy.
 *
 * Returns NULL when the setting is absent or empty, which makes every policy compare
 * false and therefore returns zero rows and rejects every write. An invalid value
 * raises a cast error: that is also a closed failure, not an open one.
 */
CREATE OR REPLACE FUNCTION app.current_shop_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.shop_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app.current_shop_id() IS
  'Tenant key for RLS. Set only by withTenant() via set_config(..., true).';

/** Keep updated_at and the optimistic-concurrency version in step on every UPDATE. */
CREATE OR REPLACE FUNCTION app.touch_versioned_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.touch_versioned_row() IS
  'BEFORE UPDATE trigger for tables with updated_at and version.';

/** Append-only tables reject row mutation even for a role that somehow holds the grant. */
CREATE OR REPLACE FUNCTION app.reject_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23P01',
          HINT = 'Post a reversing entry instead of changing history.';
END;
$$;

/**
 * TRUNCATE is not filtered by row-level security, so it needs its own statement trigger.
 * The application role also has no TRUNCATE grant; this is the second line of defence.
 */
CREATE OR REPLACE FUNCTION app.reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects TRUNCATE', TG_TABLE_NAME
    USING ERRCODE = '23P01';
END;
$$;
