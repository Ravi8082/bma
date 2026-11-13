import { readFileSync } from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { afterAll, beforeEach, beforeAll } from "vitest";
import { connectMongo, disconnectMongo } from "../../config/db";

function readTestUri(): string {
  if (process.env.MONGODB_TEST_URI) return process.env.MONGODB_TEST_URI;
  const file = path.join(process.cwd(), ".data", "test-mongo-uri");
  return readFileSync(file, "utf8").trim();
}

/**
 * Connects a test suite to the shared replica set started in globalSetup and
 * gives every test a clean database. Transactions are real (not mocked), which
 * is the point: rollback and isolation behaviour must be tested against Mongo.
 */
export function useMongoReplSet(): void {
  beforeAll(async () => {
    await connectMongo(readTestUri());
  });

  beforeEach(async () => {
    const db = mongoose.connection.db;
    if (!db) return;
    const collections = await db.collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await disconnectMongo();
  });
}
