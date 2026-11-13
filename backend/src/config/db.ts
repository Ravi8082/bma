import mongoose, { type ClientSession } from "mongoose";
import { env } from "../config/env";
import { logger } from "../config/logger";

export interface MongoConnectionInfo {
  /** Standalone deployments cannot run multi-document transactions. */
  isReplicaSet: boolean;
  host: string;
  database: string;
}

let cachedInfo: MongoConnectionInfo | null = null;

export async function connectMongo(uri: string = env.MONGODB_URI): Promise<MongoConnectionInfo> {
  if (mongoose.connection.readyState === 1) {
    cachedInfo ??= await describeConnection();
    return cachedInfo;
  }

  mongoose.set("strictQuery", true);
  mongoose.set("sanitizeFilter", false);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  cachedInfo = await describeConnection();
  if (!cachedInfo.isReplicaSet) {
    // Financial writes depend on transactions. Fail loudly at boot instead of
    // discovering it during the first confirmation.
    await mongoose.disconnect();
    throw new Error(
      "MongoDB is not running as a replica set. Transactions require a replica set " +
        "(local: docker compose up, or Atlas). Standalone mongod is not supported.",
    );
  }

  logger.info({ host: cachedInfo.host, database: cachedInfo.database }, "mongo connected");
  return cachedInfo;
}

async function describeConnection(): Promise<MongoConnectionInfo> {
  const db = mongoose.connection.db;
  let isReplicaSet = false;
  if (db) {
    try {
      const hello = (await db.admin().command({ hello: 1 })) as { setName?: string };
      isReplicaSet = typeof hello.setName === "string" && hello.setName.length > 0;
    } catch {
      isReplicaSet = false;
    }
  }
  return {
    isReplicaSet,
    host: mongoose.connection.host ?? "unknown",
    database: mongoose.connection.name ?? env.MONGODB_DB_NAME,
  };
}

export async function disconnectMongo(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  cachedInfo = null;
}

export async function pingMongo(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (!db) return false;
  try {
    await db.admin().command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

export class TransactionRequiredError extends Error {
  constructor(message = "no active transaction session") {
    super(message);
    this.name = "TransactionRequiredError";
  }
}

/**
 * Run `fn` inside a MongoDB transaction. The driver retries transient
 * transaction errors and unknown commit results; everything else propagates so
 * the caller can decide (and the caller must not have sent any message yet).
 */
export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
  options: { maxCommitTimeMS?: number } = {},
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    let hasResult = false;
    await session.withTransaction(
      async () => {
        result = await fn(session);
        hasResult = true;
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        maxCommitTimeMS: options.maxCommitTimeMS ?? 10_000,
      },
    );
    if (!hasResult) {
      throw new TransactionRequiredError("transaction callback did not run");
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/** Throws unless a session is attached — used by services that must never write outside a transaction. */
export function requireSession(session: ClientSession | null | undefined): ClientSession {
  if (!session) throw new TransactionRequiredError();
  return session;
}
