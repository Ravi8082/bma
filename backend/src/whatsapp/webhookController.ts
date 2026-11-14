/**
 * WhatsApp webhook controller.
 *
 * The signature middleware runs first over the raw body and returns 401 before this handler,
 * so a bad signature produces zero writes. For a valid request this handler persists every
 * message into `inbox_messages` (idempotent on the WhatsApp message id) before it responds.
 * A persistence failure returns 5xx so Meta retries.
 */

import type { Request, Response } from "express";
import type { ClientBase } from "pg";
import { createHash } from "node:crypto";
import { env, isProduction } from "../config/env";
import { withTransaction } from "../config/db";
import { logger } from "../config/logger";
import { normalisePhone } from "../crypto/phone";
import { phoneBlindIndex } from "../crypto/blindIndex";
import { sellerAdvisoryKey } from "./advisory";
import { handleStatusWebhook, resolveShopByProviderMessageId, type StatusKind } from "./statusWebhook";

/**
 * Transaction seam. Production uses `withTransaction`; tests inject a gated or failing
 * runner to prove ordering and persistence-failure behaviour without changing the handler.
 * `ClientBase` is the shared query surface of a pooled client and a standalone client.
 */
export type WebhookTransactionRunner = <T>(fn: (client: ClientBase) => Promise<T>) => Promise<T>;

interface WhatsAppMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  [key: string]: unknown;
}

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          errors?: Array<{ code?: number; title?: string; message?: string }>;
        }>;
      };
    }>;
  }>;
}

const ALLOWED_TYPES = new Set([
  "TEXT",
  "AUDIO",
  "IMAGE",
  "DOCUMENT",
  "INTERACTIVE",
  "TEMPLATE",
  "SYSTEM",
  "STICKER",
  "LOCATION",
  "REACTION",
  "CONTACT",
  "GROUP",
  "UNKNOWN",
]);

function mapMessageType(raw: string | undefined): string {
  const upper = (raw ?? "text").toUpperCase();
  if (upper === "BUTTON") return "INTERACTIVE";
  return ALLOWED_TYPES.has(upper) ? upper : "UNKNOWN";
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function extractMessages(payload: WhatsAppWebhookPayload): Array<{
  waMessageId: string;
  from: string;
  timestamp: string;
  type: string;
  body: Record<string, unknown>;
}> {
  const messages: Array<{
    waMessageId: string;
    from: string;
    timestamp: string;
    type: string;
    body: Record<string, unknown>;
  }> = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (!message.id || !message.from) continue;
        messages.push({
          waMessageId: message.id,
          from: message.from,
          timestamp: message.timestamp ?? String(Math.floor(Date.now() / 1000)),
          type: mapMessageType(message.type),
          body: message as Record<string, unknown>,
        });
      }
    }
  }

  return messages;
}

function mapStatus(raw: string | undefined): StatusKind | null {
  switch ((raw ?? "").toLowerCase()) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

function extractStatuses(payload: WhatsAppWebhookPayload): Array<{
  providerMessageId: string;
  status: StatusKind;
  occurredAt: Date;
  errorMessage: string | undefined;
}> {
  const statuses: Array<{
    providerMessageId: string;
    status: StatusKind;
    occurredAt: Date;
    errorMessage: string | undefined;
  }> = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id) continue;
        const mapped = mapStatus(status.status);
        if (!mapped) continue;
        const occurredAt = status.timestamp
          ? new Date(Number(status.timestamp) * 1000)
          : new Date();
        const errorMessage =
          status.errors?.[0]?.title ?? status.errors?.[0]?.message ?? undefined;
        statuses.push({
          providerMessageId: status.id,
          status: mapped,
          occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
          errorMessage,
        });
      }
    }
  }
  return statuses;
}

export async function handleWebhookPost(
  req: Request,
  res: Response,
  runTransaction: WebhookTransactionRunner = withTransaction,
): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !Buffer.isBuffer(rawBody)) {
    res.status(400).json({ ok: false, error: { code: "MISSING_BODY", message: "raw body not available" } });
    return;
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as WhatsAppWebhookPayload;
  } catch {
    res.status(400).json({ ok: false, error: { code: "INVALID_JSON", message: "invalid JSON body" } });
    return;
  }

  const messages = extractMessages(payload);
  const statuses = extractStatuses(payload);
  if (messages.length === 0 && statuses.length === 0) {
    // Status callbacks and other non-message changes are acknowledged without a write.
    res.status(200).json({ ok: true });
    return;
  }

  const bodyHash = sha256(rawBody);

  try {
    for (const message of messages) {
      await runTransaction(async (client) => {
        let shopId: string | null = null;
        let fromBidx: Buffer | null = null;
        try {
          const normalised = normalisePhone(message.from);
          fromBidx = phoneBlindIndex(normalised, env.PHONE_BLIND_INDEX_KEY);
          const shop = await client.query(
            "SELECT shop_id FROM app.resolve_seller_by_phone($1)",
            [fromBidx],
          );
          shopId = (shop.rows[0] as { shop_id?: string } | undefined)?.shop_id ?? null;
        } catch {
          shopId = null;
        }

        // Unknown senders belong to onboarding, which is a later phase. Acknowledge so Meta
        // stops retrying; nothing is written because inbox_messages requires a shop.
        if (!shopId || !fromBidx) return;

        // Serialize inserts per seller. The transaction-scoped lock is held until COMMIT, so
        // a message with a later arrival sequence can never commit before an earlier one.
        // Without this, the claim's `NOT EXISTS earlier arrival_seq` check could see only the
        // later message and process it first.
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [sellerAdvisoryKey(shopId)]);

        // One sequence value per persisted message. A batch-wide base + index would collide
        // with a concurrent delivery and make per-seller ordering ambiguous.
        const seq = await client.query<{ nextval: string }>(
          "SELECT nextval('app.inbox_arrival_seq') AS nextval",
        );
        const arrivalSeq = seq.rows[0]?.nextval ?? "0";

        await client.query(
          `INSERT INTO app.inbox_messages
             (shop_id, wa_message_id, message_type, body, raw_payload, body_hash,
              from_phone_bidx, arrival_seq, received_at, status)
           VALUES
             ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, to_timestamp($9::double precision), 'RECEIVED')
           ON CONFLICT (shop_id, wa_message_id) DO NOTHING`,
          [
            shopId,
            message.waMessageId,
            message.type,
            JSON.stringify(message.body),
            JSON.stringify({ message: message.body }),
            bodyHash,
            fromBidx,
            arrivalSeq,
            Number(message.timestamp),
          ],
        );
      });
    }

    for (const status of statuses) {
      const shopId = await resolveShopByProviderMessageId(status.providerMessageId);
      if (!shopId) continue;
      await handleStatusWebhook(
        shopId,
        status.providerMessageId,
        status.status,
        status.occurredAt,
        status.errorMessage,
      );
    }
  } catch (error) {
    logger.error({ err: error }, "webhook persistence failed");
    res.status(500).json({
      ok: false,
      error: {
        code: "PERSISTENCE_FAILED",
        message: "could not persist message",
        ...(isProduction ? {} : { detail: error instanceof Error ? error.message : String(error) }),
      },
    });
    return;
  }

  res.status(200).json({ ok: true });
}

export function handleWebhookGet(req: Request, res: Response, verifyToken: string): void {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken && typeof challenge === "string") {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ ok: false, error: { code: "VERIFICATION_FAILED", message: "invalid verify token" } });
}
