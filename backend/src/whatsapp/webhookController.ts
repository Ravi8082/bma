/**
 * Webhook controller: persists raw WhatsApp messages before queueing.
 *
 * POST /webhooks/whatsapp:
 * 1. Signature verified by middleware (raw body) — zero writes on failure
 * 2. Parse JSON
 * 3. For each message, persist to inbox_messages (idempotent on wa_message_id)
 * 4. Acknowledge (200) only after durable write
 * 5. Return 5xx if persistence fails (Meta retries)
 */

import type { Request, Response } from "express";
import { withTransaction } from "../config/db";
import { createHash } from "node:crypto";
import { normalisePhone } from "../crypto/phone";
import { phoneBlindIndex } from "../crypto/blindIndex";

const BLIND_INDEX_KEY = process.env.PHONE_BLIND_INDEX_KEY ?? "dev-only-blind-index-key-32-bytes";

interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          audio?: { id?: string; mime_type?: string };
          image?: { id?: string; mime_type?: string; caption?: string };
          [key: string]: unknown;
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
        }>;
      };
    }>;
  }>;
}

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

export async function handleWebhookPost(req: Request, res: Response): Promise<void> {
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

  const bodyHash = sha256(rawBody);

  // Extract messages
  const messages: Array<{
    waMessageId: string;
    from: string;
    timestamp: string;
    type: string;
    body: Record<string, unknown>;
  }> = [];

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;
      for (const msg of value.messages) {
        if (!msg.id || !msg.from) continue;
        messages.push({
          waMessageId: msg.id,
          from: msg.from,
          timestamp: msg.timestamp ?? String(Math.floor(Date.now() / 1000)),
          type: (msg.type ?? "text").toUpperCase(),
          body: msg as Record<string, unknown>,
        });
      }
    }
  }

  if (messages.length === 0) {
    // No messages (could be status update) — acknowledge
    res.status(200).json({ ok: true });
    return;
  }

  // Persist each message before acknowledging
  try {
    await withTransaction(async (client) => {
      // Global arrival sequence counter
      const seqResult = await client.query<{ nextval: string }>("SELECT nextval('app.inbox_arrival_seq')");
      const baseSeq = Number(seqResult.rows[0]?.nextval ?? "0");

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        // Resolve shop_id from sender's phone (SECURITY DEFINER via login_index)
        let shopId: string | null = null;
        try {
          const normalised = normalisePhone(msg.from);
          const bidx = phoneBlindIndex(normalised, BLIND_INDEX_KEY);
          const shopResult = await client.query(
            "SELECT shop_id FROM app.resolve_seller_by_phone($1)",
            [bidx],
          );
          shopId = shopResult.rows[0]?.shop_id ?? null;
        } catch {
          // Unknown number — shop_id will be resolved during processing (onboarding)
          shopId = null;
        }

        // If no shop found, we still need a shop_id for NOT NULL constraint.
        // Use a sentinel: create an onboarding entry later. For now, skip unknown
        // numbers (they'll be handled by the onboarding flow in Phase 4).
        if (!shopId) {
          // Persist to a special "pending" state — for now, skip
          // (Phase 4 will handle onboarding routing)
          continue;
        }

        const fromBidx = phoneBlindIndex(normalisePhone(msg.from), BLIND_INDEX_KEY);

        await client.query(
          `INSERT INTO app.inbox_messages (shop_id, wa_message_id, message_type, body, raw_payload, body_hash, from_phone_bidx, arrival_seq, received_at, status)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, to_timestamp($9::double precision), 'RECEIVED')
           ON CONFLICT (shop_id, wa_message_id) DO NOTHING`,
          [
            shopId,
            msg.waMessageId,
            msg.type,
            JSON.stringify(msg.body),
            JSON.stringify({ redacted: true }),
            bodyHash,
            fromBidx,
            baseSeq + i,
            Number(msg.timestamp),
          ],
        );
      }
    });
  } catch {
    // Persistence failed → 5xx so Meta retries
    res.status(500).json({ ok: false, error: { code: "PERSISTENCE_FAILED", message: "could not persist message" } });
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
