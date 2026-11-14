import { Router } from "express";
import { verifyWebhookSignature } from "./webhookSignature";
import {
  handleWebhookGet,
  handleWebhookPost,
  type WebhookTransactionRunner,
} from "./webhookController";

/**
 * WhatsApp webhook routes.
 *
 * GET  /webhooks/whatsapp  — Meta subscription verification.
 * POST /webhooks/whatsapp  — signature check over the raw body, then durable persistence.
 *                            The handler responds only after the insert commits.
 *
 * `runTransaction` exists for tests: the production default is `withTransaction`, while a
 * test can inject a gated runner (ordering) or a runner that loses the connection (5xx).
 */
export function createWebhookRouter(
  appSecret: string,
  verifyToken: string,
  runTransaction?: WebhookTransactionRunner,
): Router {
  const router = Router();

  router.get("/", (req, res) => {
    handleWebhookGet(req, res, verifyToken);
  });

  router.post("/", verifyWebhookSignature(appSecret), (req, res) => {
    void handleWebhookPost(req, res, runTransaction);
  });

  return router;
}
