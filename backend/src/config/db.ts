import { Client, Pool, type PoolClient } from "pg";
import { env } from "./env";
import { logger } from "./logger";

/**
 * One pool per process, connecting as `bma_app`.
 *
 * The migrator credentials are deliberately not part of this process: migrations run in a
 * separate deploy step (or the test bootstrap). The runtime role has no DDL, no TRUNCATE and
 * no BYPASSRLS, and `connectDb()` refuses to start if the configured role turns out to be a
 * superuser.
 */
let pool: Pool | null = null;

export function getPool(connectionString: string = env.DATABASE_URL): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    application_name: "bma-api",
    // Enforced by the server for every connection, not by a per-query convention.
    options:
      "-c statement_timeout=5000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
    ...sslOptions(),
  });
  pool.on("error", (error) => {
    // An idle client failed. The pool discards it; log without the connection string.
    logger.error({ err: error }, "idle postgres client error");
  });
  return pool;
}

function sslOptions(): { ssl?: boolean | { rejectUnauthorized: boolean } } {
  if (env.DB_SSL_MODE === "disable") return {};
  if (env.DB_SSL_MODE === "require") return { ssl: { rejectUnauthorized: false } };
  return { ssl: { rejectUnauthorized: true } };
}

export interface DatabaseInfo {
  version: string;
  database: string;
  role: string;
  encoding: string;
}

export async function connectDb(connectionString: string = env.DATABASE_URL): Promise<DatabaseInfo> {
  // Validate on a dedicated connection. The runtime pool may already be bound to another
  // database (tests use this to probe a deliberately mis-encoded cluster); a failed check
  // must not leave a pool pointed at a database the server is refusing to use.
  const client = new Client({
    connectionString,
    application_name: "bma-api-startup",
    connectionTimeoutMillis: 5_000,
    ...sslOptions(),
  });
  await client.connect();
  try {
    const result = await client.query<{
      version: string;
      database: string;
      role: string;
      encoding: string;
    }>(
      `SELECT version(),
              current_database() AS database,
              current_user AS role,
              pg_encoding_to_char(d.encoding) AS encoding
         FROM pg_database d
        WHERE d.datname = current_database()`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("database did not return a version row");

    if (row.encoding !== "UTF8") {
      throw new Error(
        `refusing to start: database "${row.database}" uses encoding ${row.encoding}; ` +
          "Business Memory AI requires UTF8 so the rupee sign and other non-ASCII text " +
          "can be stored safely",
      );
    }

    const privileges = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT r.rolsuper, r.rolbypassrls
         FROM pg_roles r
        WHERE r.rolname = current_user`,
    );
    const role = privileges.rows[0];
    if (!role) throw new Error(`role ${row.role} was not found in pg_roles`);
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `refusing to run as ${row.role}: the application role must be NOSUPERUSER NOBYPASSRLS ` +
          "(RLS cannot protect a superuser)",
      );
    }

    // All startup checks passed: now bind the process-wide runtime pool.
    getPool(connectionString);

    logger.info(
      { database: row.database, role: row.role, version: row.version, encoding: row.encoding },
      "postgres connected",
    );
    return row;
  } finally {
    await client.end();
  }
}

export async function disconnectDb(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}

/** Readiness probe: bounded to one second and never tenant-scoped. */
export async function pingDb(connectionString: string = env.DATABASE_URL): Promise<boolean> {
  const client = await getPool(connectionString).connect();
  let healthy = false;
  try {
    await client.query("SET statement_timeout = '1s'");
    await client.query("SELECT 1");
    healthy = true;
  } catch (error) {
    logger.error({ err: error }, "postgres ping failed");
  } finally {
    try {
      // RESET is safe here: the connection is only used for the probe and the pool
      // reapplies server defaults through its connection options on reuse.
      await client.query("RESET statement_timeout");
    } catch {
      healthy = false;
    }
    client.release(!healthy ? true : undefined);
  }
  return healthy;
}

export function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "40001" || code === "40P01";
}

const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Run `fn` inside one PostgreSQL transaction on one pooled client.
 *
 * Serialization failures and deadlocks are retried a bounded number of times; everything
 * else propagates. `set_config(..., true)` in `withTenant()` is transaction-scoped, so the
 * context disappears on COMMIT/ROLLBACK even behind a transaction-mode pooler.
 *
 * A client is released exactly once. If ROLLBACK itself fails, the connection is destroyed
 * rather than returned to the pool with an unknown session state.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransactionOnPool(getPool(), fn);
}

/** Same transaction contract as `withTransaction`, against an explicitly supplied pool. */
export async function withTransactionOnPool<T>(
  currentPool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await currentPool.connect();
    let released = false;
    let destroy = false;
    const release = (): void => {
      if (released) return;
      released = true;
      client.release(destroy ? true : undefined);
    };

    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroy = true;
        logger.error({ err: rollbackError }, "rollback failed; destroying the connection");
      }

      if (isRetryableTransactionError(error) && attempt < MAX_TRANSACTION_ATTEMPTS) {
        logger.warn({ attempt, code: (error as { code?: string }).code }, "retrying transaction");
        release();
        continue;
      }

      throw error;
    } finally {
      release();
    }
  }
}
