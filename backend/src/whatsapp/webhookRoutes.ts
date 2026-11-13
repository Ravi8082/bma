import { Router } from "express";
import { verifyWebhookSignature } from "./webhookSignature";

export function createWebhookRouter(appSecret: string, verifyToken: string): Router {
  const router = Router();

  // GET verification
  router.get("/", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === verifyToken && typeof challenge === "string") {
      res.status(200).send(challenge);
      return;
    }
    res.status(403).json({ ok: false, error: { code: "VERIFICATION_FAILED", message: "invalid verify token" } });
  });

  // POST webhook (signature verified before handler)
  router.post("/", verifyWebhookSignature(appSecret), (_req, res) => {
    // The handler persists the raw message and queues processing.
    // For Phase 3, we acknowledge receipt; processing happens via the inbox.
    res.status(200).json({ ok: true });
  });

  return router;
}
