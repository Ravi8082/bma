import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { connectDb, disconnectDb } from "../../config/db";
import { withTenant, type TenantContext, type TenantDb } from "../../db/tenant";

const URI_FILE = path.join(process.cwd(), ".data", "test-pg-uri");
const BOOTSTRAP_URI_FILE = path.join(process.cwd(), ".data", "test-pg-bootstrap-uri");

export function readTestDatabaseUrl(): string {
  const fromEnv = process.env.TEST_DATABASE_URL;
  if (fromEnv) return fromEnv;
  const uri = readFileSync(URI_FILE, "utf8").trim();
  if (!uri) throw new Error("no test database URI was written by globalSetup");
  return uri;
}

/** Superuser URI for test-only cluster operations (create/drop a probe database). */
export function readTestBootstrapUrl(): string {
  const fromEnv = process.env.TEST_BOOTSTRAP_DATABASE_URL;
  if (fromEnv) return fromEnv;
  const uri = readFileSync(BOOTSTRAP_URI_FILE, "utf8").trim();
  if (!uri) throw new Error("no bootstrap database URI was written by globalSetup");
  return uri;
}

export async function usePostgres(): Promise<void> {
  beforeAll(async () => {
    await connectDb(readTestDatabaseUrl());
  });

  afterAll(async () => {
    await disconnectDb();
  });
}

export function newTestShopId(): string {
  // Fresh UUID per test: the disposable database accumulates append-only rows but never sees
  // rows from another test.
  return randomUUID();
}

export async function withTestShop<T>(
  fn: (context: TenantContext, db: TenantDb) => Promise<T>,
): Promise<T> {
  const context: TenantContext = {
    shopId: newTestShopId(),
    actorType: "SYSTEM",
    actorId: `test-${randomUUID()}`,
  };
  return withTenant(context, async (db) => fn(context, db));
}
