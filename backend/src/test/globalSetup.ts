import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * One replica set for the whole suite.
 *
 * Starting a replica set per test file competes for ports and exceeds the
 * 10 s boot window once there are four database suites. globalSetup runs once,
 * writes the URI to a git-ignored file, and every suite connects to it.
 */
const REPO_ROOT = process.cwd();
const DATA_DIR = path.join(REPO_ROOT, ".data");
const URI_FILE = path.join(DATA_DIR, "test-mongo-uri");

let replSet: MongoMemoryReplSet | undefined;

export async function setup(): Promise<void> {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(URI_FILE, replSet.getUri("business_memory_test"), "utf8");
}

export async function teardown(): Promise<void> {
  const instance = replSet;
  replSet = undefined;
  if (instance) await instance.stop();
  rmSync(URI_FILE, { force: true });
}
