import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Webhook signature verification for Meta WhatsApp webhooks.
 *
 * Verifies X-Hub-Signature-256 over the raw body. Constant-time comparison.
 * The raw body must be captured before JSON parsing.
 */

export function verifyWebhookSignature(
  appSecret: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
      res.status(401).json({ ok: false, error: { code: "INVALID_SIGNATURE", message: "missing signature" } });
      return;
    }

    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !Buffer.isBuffer(rawBody)) {
      res.status(400).json({ ok: false, error: { code: "MISSING_BODY", message: "raw body not available" } });
      return;
    }

    const expected = createHmac("sha256", appSecret).update(rawBody).digest();
    const provided = Buffer.from(signature.slice(7), "hex");

    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ ok: false, error: { code: "INVALID_SIGNATURE", message: "signature mismatch" } });
      return;
    }

    next();
  };
}

/**
 * Capture the raw body before JSON parsing.
 * Must be registered as the first middleware on the webhook route.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
}
