import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import EmbeddedPostgres from "embedded-postgres";
import { GenericContainer, Wait } from "testcontainers";
import { migrate } from "postgres-migrations";

const REPO_ROOT = process.cwd();
const DATA_DIR = path.join(REPO_ROOT, ".data");
const URI_FILE = path.join(DATA_DIR, "test-pg-uri");
const DATABASE_NAME = "business_memory";
// Deliberately separate from the developer's PostgreSQL service and from an abandoned
// fallback process after an interrupted test run.
const EMBEDDED_PORT = 54330;

interface ProviderHandle {
  uri: string;
  bootstrapUrl: string;
  stop: () => Promise<void>;
}

let handle: ProviderHandle | undefined;

async function startEmbeddedPostgres(): Promise<ProviderHandle> {
  const databaseDir = path.join(DATA_DIR, "embedded-postgres-test");
  const instance = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port: EMBEDDED_PORT,
    // `embedded-postgres` races Windows file handles while deleting a non-persistent
    // cluster at teardown. The test database is disposable by unique shop UUID; keeping
    // the local cluster avoids a false red run and never changes the Testcontainers CI path.
    persistent: true,
  });
  if (!existsSync(databaseDir)) await instance.initialise();
  await instance.start();
  const admin = instance.getPgClient();
  await admin.connect();
  try {
    const existing = await admin.query<{ encoding: string }>(
      "SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1",
      [DATABASE_NAME],
    );
    const currentEncoding = existing.rows[0]?.encoding;
    if (currentEncoding && currentEncoding !== "UTF8") {
      // On Windows, initdb defaults to WIN1252, which cannot store the rupee sign.
      // The cluster is disposable: drop the stale database and recreate it as UTF-8.
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [DATABASE_NAME],
      );
      await admin.query(`DROP DATABASE ${DATABASE_NAME}`);
    }
    if (!currentEncoding || currentEncoding !== "UTF8") {
      await admin.query(
        `CREATE DATABASE ${DATABASE_NAME} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
    }
  } finally {
    await admin.end();
  }
  const uri = `postgres://postgres:postgres@localhost:${EMBEDDED_PORT}/${DATABASE_NAME}`;
  return { uri, bootstrapUrl: `postgres://postgres:postgres@localhost:${EMBEDDED_PORT}/postgres`, stop: async () => { await instance.stop(); } };
}

async function startTestcontainers(): Promise<ProviderHandle> {
  const container = await new GenericContainer("postgres:16-alpine")
    .withName("bma-pg-test")
    .withEnvironment({
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_DB: DATABASE_NAME,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/.*database system is ready to accept connections.*/, 2))
    .withStartupTimeout(240_000)
    .start();

  const hostPort = container.getMappedPort(5432);
  const uri = `postgres://postgres:postgres@${container.getHost()}:${hostPort}/${DATABASE_NAME}`;
  return {
    uri,
    bootstrapUrl: `postgres://postgres:postgres@${container.getHost()}:${hostPort}/postgres`,
    stop: async () => {
      await container.stop();
    },
  };
}

async function bootstrap(bootstrapUrl: string): Promise<string> {
  const bootstrap = new Client({ connectionString: bootstrapUrl });
  await bootstrap.connect();

  const roles = [
    ["bma_migrator", process.env.BMA_MIGRATOR_PASSWORD ?? "dev-migrator-password"],
    ["bma_app", process.env.BMA_APP_PASSWORD ?? "dev-app-password"],
    ["bma_reporting", process.env.BMA_REPORTING_PASSWORD ?? "dev-reporting-password"],
  ];
  for (const [name, password] of roles) {
    const existing = await bootstrap.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname = $1",
      [name],
    );
    if (existing.rows.length > 0) continue;
    await bootstrap.query(
      `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`,
    );
  }

  const created = await bootstrap.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [DATABASE_NAME],
  );
  if (!created.rows[0]?.exists) {
    await bootstrap.query(
      `CREATE DATABASE ${DATABASE_NAME} OWNER bma_migrator ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
    );
  } else {
    await bootstrap.query(`ALTER DATABASE ${DATABASE_NAME} OWNER TO bma_migrator`);
  }

  await bootstrap.query(`REVOKE ALL ON DATABASE ${DATABASE_NAME} FROM PUBLIC`);
  for (const [name] of roles) {
    await bootstrap.query(`GRANT CONNECT ON DATABASE ${DATABASE_NAME} TO ${name}`);
  }
  await bootstrap.end();

  const parsed = new URL(bootstrapUrl.replace(/^postgres:\/\//, "http://"));
  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 5432;
  const migratorPassword = process.env.BMA_MIGRATOR_PASSWORD ?? "dev-migrator-password";
  const migrator = new Client({
    connectionString: `postgres://bma_migrator:${migratorPassword}@${host}:${port}/${DATABASE_NAME}`,
  });
  await migrator.connect();
  try {
    await migrator.query("CREATE SCHEMA IF NOT EXISTS app");
    await migrator.query("SET search_path TO app, public");
    const applied = await migrate({ client: migrator }, path.resolve(REPO_ROOT, "migrations"), {
      logger: () => undefined,
    });
    console.info(`migrations applied: ${applied.length}`);
  } finally {
    await migrator.end();
  }

  const uri = `postgres://${process.env.BMA_APP_USERNAME ?? "bma_app"}:${
    process.env.BMA_APP_PASSWORD ?? "dev-app-password"
  }@${host}:${port}/${DATABASE_NAME}`;
  process.env.DATABASE_URL = uri;
  return uri;
}

export async function setup(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const provider = process.env.TEST_DB_PROVIDER === "embedded" ? await startEmbeddedPostgres() : await startTestcontainers();
  handle = provider;
  const uri = await bootstrap(provider.bootstrapUrl);
  writeFileSync(URI_FILE, uri, "utf8");
}

export async function teardown(): Promise<void> {
  if (handle) {
    const current = handle;
    handle = undefined;
    await current.stop();
  }
}
