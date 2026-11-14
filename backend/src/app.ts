import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env, isProduction } from "./config/env";
import { logger } from "./config/logger";
import { createHealthRouter, type HealthDependencies } from "./health/health.routes";
import { errorHandler } from "./middleware/error";
import { notFoundHandler } from "./middleware/notFound";
import { requestId } from "./middleware/requestId";
import { createSimulatorRouter } from "./simulator/simulator.routes";
import { createWebhookRouter } from "./whatsapp/webhookRoutes";
import { captureRawBody } from "./whatsapp/webhookSignature";

export interface AppDependencies {
  health?: Partial<HealthDependencies>;
  /** Mount the WhatsApp webhook only when a secret and verify token are configured. */
  webhook?: { appSecret: string; verifyToken: string };
}

export function createApp(deps: AppDependencies = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", isProduction ? 1 : false);

  app.use(requestId);
  app.use(helmet());
  app.use(
    cors({
      origin: allowedOrigins(),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "1mb", verify: captureRawBody }));

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) =>
        typeof (res as unknown as { locals?: { requestId?: string } }).locals?.requestId === "string"
          ? ((res as unknown as { locals: { requestId: string } }).locals.requestId)
          : "unknown",
      autoLogging: {
        ignore: (req) => (req.url ?? "").startsWith("/health"),
      },
    }),
  );

  app.use("/health", createHealthRouter(deps.health));

  if (!isProduction) {
    app.use("/simulator", createSimulatorRouter());
  }

  if (deps.webhook) {
    app.use(
      "/webhooks/whatsapp",
      createWebhookRouter(deps.webhook.appSecret, deps.webhook.verifyToken),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function allowedOrigins(): string[] {
  const configured = env.DASHBOARD_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (isProduction) return configured;

  return Array.from(new Set([...configured, "http://localhost:5173", "http://127.0.0.1:5173"]));
}
