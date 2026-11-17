import { describe, expect, it } from "vitest";
import { getPool } from "../../config/db";
import { usePostgres } from "../helpers/postgres";

/**
 * Database catalog invariants (DB-18, DB-19, DB-44, DB-48).
 *
 * Runs against a real PostgreSQL as `bma_app` (`NOSUPERUSER NOBYPASSRLS`) through the same
 * pool the application uses, so a policy the superuser could not see still fails here.
 */
usePostgres();

describe("database catalog invariants", () => {
  it("fails when a shop-owned table lacks FORCE RLS, a policy or NOT NULL", async () => {
    const client = await getPool().connect();
    try {
      const violations = await client.query<{ table_name: string }>(
        `SELECT c.relname AS table_name
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id'
          WHERE n.nspname = 'app'
            AND c.relkind = 'r'
            AND c.relname NOT IN ('security_events', 'login_index', 'inbox_messages', 'provider_message_index', 'evening_schedule')
            AND (NOT a.attnotnull OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity
                 OR NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname))`,
      );

      expect(violations.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("keeps application key material out of the database", async () => {
    const client = await getPool().connect();
    try {
      const keyMaterial = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'app'
            AND column_name IN ('otp_pepper','encryption_key','data_key','master_key','blind_index_key','password_hash','totp_secret');`,
      );

      expect(keyMaterial.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("grants the application and reporting roles only what the design allows", async () => {
    const client = await getPool().connect();
    try {
      for (const role of ["bma_app", "bma_reporting", "bma_migrator"]) {
        const row = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
          `SELECT r.rolname, r.rolsuper, r.rolbypassrls
             FROM pg_roles r
            WHERE r.rolname = $1`,
          [role],
        );
        expect(row.rows).toHaveLength(1);
        const found = row.rows[0];
        expect(found?.rolsuper).toBe(false);
        expect(found?.rolbypassrls).toBe(false);
      }

      const checks = [
        "SELECT has_schema_privilege('bma_app', 'app', 'CREATE') AS has",
        "SELECT has_database_privilege('bma_app', current_database(), 'TEMP') AS has",
        "SELECT has_table_privilege('bma_app', 'app.ledger_entries', 'UPDATE') AS has",
        "SELECT has_table_privilege('bma_app', 'app.ledger_entries', 'DELETE') AS has",
        "SELECT has_table_privilege('bma_app', 'app.ledger_entries', 'TRUNCATE') AS has",
        "SELECT has_table_privilege('bma_app', 'app.audit_logs', 'UPDATE') AS has",
        "SELECT has_table_privilege('bma_app', 'app.audit_logs', 'DELETE') AS has",
      ];
      for (const check of checks) {
        const result = await client.query<{ has: boolean }>(check);
        expect(result.rows[0]?.has).toBe(false);
      }
    } finally {
      client.release();
    }
  });
});
