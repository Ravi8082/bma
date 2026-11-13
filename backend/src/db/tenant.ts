import type { PoolClient } from "pg";
import { getPool } from "../config/db";
import { withTransaction } from "../config/db";
import { assertSafeStatement, type SqlQuery } from "./sql";

/**
 * Tenant context.
 *
 * There is no way to run an application query without one: `withTenant()` is the only
 * function that sets `app.shop_id`, and row-level security fails closed when it is unset.
 * The context is transaction-local (`set_config(..., true)`), so it cannot leak to the next
 * request that borrows the same pooled connection.
 */
export interface TenantContext {
  /** The only shop this transaction may see or write. Never taken from a request body. */
  readonly shopId: string;
  readonly actorType: "USER" | "ADMIN" | "SYSTEM" | "WORKER";
  readonly actorId?: string;
  /** Admin tickets issued for a read are executed in a READ ONLY transaction. */
  readonly readOnly?: boolean;
}

export type TenantViolationCode =
  | "TENANT_CONTEXT_REQUIRED"
  | "TENANT_CONTEXT_INVALID"
  | "TENANT_CONTEXT_NOT_APPLIED";

export class TenantContextError extends Error {
  readonly code: TenantViolationCode;

  constructor(code: TenantViolationCode, message: string) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function assertUuid(value: unknown, label = "id"): string {
  if (!isUuid(value)) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      `${label} must be a UUID; received ${JSON.stringify(value)}`,
    );
  }
  return value.toLowerCase();
}

function normaliseContext(context: TenantContext): TenantContext {
  if (!context || typeof context !== "object") {
    throw new TenantContextError(
      "TENANT_CONTEXT_REQUIRED",
      "a tenant context is required; unscoped database access is not permitted",
    );
  }
  const shopId = assertUuid(context.shopId, "shopId");

  if (!["USER", "ADMIN", "SYSTEM", "WORKER"].includes(context.actorType)) {
    throw new TenantContextError(
      "TENANT_CONTEXT_INVALID",
      "actorType must be USER, ADMIN, SYSTEM or WORKER",
    );
  }
  if (context.actorId !== undefined && typeof context.actorId !== "string") {
    throw new TenantContextError("TENANT_CONTEXT_INVALID", "actorId must be a string");
  }

  return Object.freeze({
    shopId,
    actorType: context.actorType,
    ...(context.actorId === undefined ? {} : { actorId: context.actorId }),
    readOnly: context.readOnly === true,
  });
}

/** A shop-scoped handle. Every query through it runs with `app.shop_id` set. */
export interface TenantDb {
  readonly shopId: string;

  query<T>(query: SqlQuery): Promise<T[]>;
  queryOne<T>(query: SqlQuery): Promise<T | null>;
  /** Returns the number of affected rows. */
  execute(query: SqlQuery): Promise<number>;
}

class ScopedTenantDb implements TenantDb {
  readonly shopId: string;

  constructor(
    private readonly client: PoolClient,
    shopId: string,
  ) {
    this.shopId = shopId;
  }

  async query<T>(query: SqlQuery): Promise<T[]> {
    assertSafeStatement(query);
    const result = await this.client.query({
      text: query.text,
      values: [...query.values],
    });
    return result.rows as T[];
  }

  async queryOne<T>(query: SqlQuery): Promise<T | null> {
    const rows = await this.query<T>(query);
    return rows[0] ?? null;
  }

  async execute(query: SqlQuery): Promise<number> {
    assertSafeStatement(query);
    const result = await this.client.query({
      text: query.text,
      values: [...query.values],
    });
    return result.rowCount ?? 0;
  }
}

/**
 * Run a reviewed query without a tenant context.
 *
 * This path exists only for fail-closed tests and for platform-level lookups that will later
 * move behind a `SECURITY DEFINER` function. It must never be used to read tenant rows: without
 * a context the RLS policies return no rows, so a tenant query here fails closed by design.
 */
export async function queryWithoutTenant<T>(query: SqlQuery): Promise<T[]> {
  const client = await getPool().connect();
  try {
    assertSafeStatement(query);
    const result = await client.query({ text: query.text, values: [...query.values] });
    return result.rows as T[];
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in one transaction with a single shop in scope.
 *
 * This is the **only** place in the codebase that calls `set_config('app.shop_id', …)`.
 * `npm run check:tenant` fails the build if that string appears anywhere else.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const ctx = normaliseContext(context);

  return withTransaction(async (client) => {
    if (ctx.readOnly) {
      // Must be the first statement of the transaction. PostgreSQL then rejects any write
      // in the callback regardless of a bug in the caller.
      await client.query("SET TRANSACTION READ ONLY");
    }

    await client.query("SELECT set_config('app.shop_id', $1, true)", [ctx.shopId]);
    await client.query("SELECT set_config('app.actor_type', $1, true)", [ctx.actorType]);
    if (ctx.actorId !== undefined) {
      await client.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actorId]);
    }

    // Fail closed: prove the context the policy will read is the context we intend.
    const applied = await client.query<{ shop_id: string | null }>(
      "SELECT NULLIF(current_setting('app.shop_id', true), '') AS shop_id",
    );
    if (applied.rows[0]?.shop_id !== ctx.shopId) {
      throw new TenantContextError(
        "TENANT_CONTEXT_NOT_APPLIED",
        "tenant context was not applied; refusing to run the transaction",
      );
    }

    return fn(new ScopedTenantDb(client, ctx.shopId));
  });
}
