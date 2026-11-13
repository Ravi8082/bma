/**
 * One-time database bootstrap.
 *
 * Creates the application database and the three runtime roles. Must run as a bootstrap
 * superuser (BOOTSTRAP_DATABASE_URL); in production it is executed once by a DBA and the
 * credentials are then rotated. Never run in the application image.
 */
import { Client } from "pg";
import "dotenv/config";

const DATABASE_NAME = "business_memory";

interface RoleSeed {
  readonly name: string;
  readonly password: string;
}

const ROLES: readonly RoleSeed[] = [
  { name: "bma_migrator", password: process.env.BMA_MIGRATOR_PASSWORD ?? "dev-migrator-password" },
  { name: "bma_app", password: process.env.BMA_APP_PASSWORD ?? "dev-app-password" },
  { name: "bma_reporting", password: process.env.BMA_REPORTING_PASSWORD ?? "dev-reporting-password" },
];

async function createDatabase(bootstrap: Client): Promise<void> {
  const existing = await bootstrap.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [DATABASE_NAME],
  );
  if (existing.rows[0]?.exists) return;
  // CREATE DATABASE takes a constant name; the database itself is not user data.
  await bootstrap.query(`CREATE DATABASE ${DATABASE_NAME} OWNER bma_migrator`);
}

async function createRoles(bootstrap: Client): Promise<void> {
  for (const role of ROLES) {
    const existing = await bootstrap.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [role.name],
    );
    if (existing.rows.length > 0) continue;
    await bootstrap.query(
      `CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
  }
}

async function grantDatabaseAccess(bootstrap: Client): Promise<void> {
  await bootstrap.query(`REVOKE ALL ON DATABASE CURRENT_DATABASE FROM PUBLIC`);
  for (const role of ROLES) {
    await bootstrap.query(
      `GRANT CONNECT ON DATABASE CURRENT_DATABASE TO ${role.name}`,
    );
  }
}

async function main(): Promise<void> {
  const url = process.env.BOOTSTRAP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("BOOTSTRAP_DATABASE_URL is required to bootstrap the database");

  const bootstrap = new Client({ connectionString: url });
  await bootstrap.connect();

  try {
    await createRoles(bootstrap);
    await createDatabase(bootstrap);
    await grantDatabaseAccess(bootstrap);
  } finally {
    await bootstrap.end();
  }
}

void main();
