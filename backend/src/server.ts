import { createServer } from "node:http";
import { createApp } from "./app";
import { connectDb, disconnectDb } from "./config/db";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { queue } from "./container";

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  const connection = await connectDb();
  logger.info(
    { database: connection.database, role: connection.role, version: connection.version },
    "database ready",
  );

  const app = createApp();
  const server = createServer(app);

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, messaging: env.MESSAGING_PROVIDER },
      "api listening",
    );
    if (!isProductionLike()) {
      logger.info(`simulator inbox: http://localhost:${env.PORT}/simulator`);
    }
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      await queue.close();
      await disconnectDb();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, "shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    process.exit(1);
  });
}

function isProductionLike(): boolean {
  return env.NODE_ENV === "production";
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, "failed to start");
  process.exit(1);
});
