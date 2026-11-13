import { Router } from "express";
import { env } from "../config/env";
import { pingDb } from "../config/db";
import { queue } from "../container";

export interface HealthDependencies {
  pingDatabase?: () => Promise<boolean>;
  pingQueue?: () => Promise<boolean>;
}

export function createHealthRouter(deps: HealthDependencies = {}): Router {
  const router = Router();
  const pingDatabase = deps.pingDatabase ?? pingDb;
  const pingQueue = deps.pingQueue ?? ((): Promise<boolean> => queue.ping());

  router.get("/", (_req, res) => {
    res.json({
      ok: true,
      data: {
        status: "ok",
        service: "business-memory-ai",
        env: env.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
        now: new Date().toISOString(),
      },
    });
  });

  router.get("/ready", async (_req, res) => {
    const [database, queueReady] = await Promise.allSettled([
      pingDatabase(),
      pingQueue(),
    ]);
    const components = {
      database: database.status === "fulfilled" && database.value,
      queue: queueReady.status === "fulfilled" && queueReady.value,
    };
    const ready = components.database && components.queue;

    res.status(ready ? 200 : 503).json({
      ok: ready,
      data: {
        ready,
        components,
        queue: queue.stats(),
        checkedAt: new Date().toISOString(),
      },
    });
  });

  return router;
}
