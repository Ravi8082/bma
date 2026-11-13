/**
 * Run forward-only database migrations (postgres-migrations).
 *
 * Migration files must be named <id>_<snake_case_name>.sql with consecutive ids starting at 1.
 * A changed hash of an already-applied migration fails the run, so migrations are immutable.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { migrate } from "postgres-migrations";
import "dotenv/config";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required to run migrations");

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const role = await client.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");

    const currentUser = role.rows[0]?.rolname;
    if (!currentUser) throw new Error("migration client user was not found in pg_roles");
    if (currentUser !== "bma_migrator") {
      throw new Error(`migrations must run as bma_migrator, got ${currentUser}`);
    }
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) {
      throw new Error("migrations must run as bma_migrator (NOSUPERUSER NOBYPASSRLS)");
    }

    await client.query("CREATE SCHEMA IF NOT EXISTS app");
    await client.query("SET search_path TO app, public");
    const applied = await migrate({ client }, MIGRATIONS_DIR, { logger: () => {} });
    console.info(`migrations applied: ${applied.map((m) => `${m.id}:${m.name}`).join(", ") || "none"}`);
  } finally {
    await client.end();
  }
}

void main();
