import { Router } from "express";
import { verifyWebhookSignature } from "./webhookSignature";
import { handleWebhookGet, handleWebhookPost } from "./webhookController";

/**
 * WhatsApp webhook routes.
 *
 * GET  /webhooks/whatsapp  — Meta subscription verification.
 * POST /webhooks/whatsapp  — signature check over the raw body, then durable persistence.
 *                            The handler responds only after the insert commits.
 */
export function createWebhookRouter(appSecret: string, verifyToken: string): Router {
  const router = Router();

  router.get("/", (req, res) => {
    handleWebhookGet(req, res, verifyToken);
  });

  router.post("/", verifyWebhookSignature(appSecret), (req, res) => {
    void handleWebhookPost(req, res);
  });

  return router;
}
