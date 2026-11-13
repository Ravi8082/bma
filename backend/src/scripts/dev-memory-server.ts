/**
 * Local development without Docker.
 *
 * Starts a single-node MongoDB replica set in memory, points the app at it,
 * then boots the real server. Data is intentionally ephemeral: this is for
 * demos and manual testing, never for staging or production.
 */
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV ??= "development";
process.env.QUEUE_DRIVER = "inline";
process.env.MESSAGING_PROVIDER = "simulator";

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
});

process.env.MONGODB_URI = replSet.getUri("business_memory");

const shutdown = async (): Promise<void> => {
  await replSet.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await import("../server");
