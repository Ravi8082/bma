/**
 * Outbound sender: claim a queued message, call the MessagingProvider outside any database
 * transaction, then record the result. The provider is the only place that knows whether it
 * is talking to Meta or the simulator.
 */

import { decryptField } from "../crypto/fieldEncryption";
import type { MessagingProvider } from "../integrations/messaging/types";
import { raiseOutboxDeadLetter, raiseOutboxStale } from "./alerts";
import { claimNextOutbound, markFailed, markSent, type OutboundState } from "./outbound";
import { queryWithoutTenant, withTenant } from "../db/tenant";
import { sql } from "../db/sql";

export interface OutboundDeps {
  messaging: MessagingProvider;
  keyRef: string;
}

export interface OutboundResult {
  processed: boolean;
  state: OutboundState | "EMPTY";
  outboxId?: string;
}

interface OutboundPayload {
  to?: string;
  text?: string;
  body?: string;
  buttons?: { id: string; title: string }[];
}

function parsePayload(value: Record<string, unknown>): OutboundPayload {
  const payload = value as OutboundPayload;
  return {
    ...(typeof payload.to === "string" ? { to: payload.to } : {}),
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(typeof payload.body === "string" ? { body: payload.body } : {}),
    ...(Array.isArray(payload.buttons) ? { buttons: payload.buttons } : {}),
  };
}

async function serviceWindowOpen(shopId: string, recipientBidx: Buffer): Promise<boolean> {
  const rows = await queryWithoutTenant<{ count: string }>(
    sql`SELECT COUNT(*) AS count FROM app.inbox_messages
         WHERE shop_id = ${shopId}
           AND from_phone_bidx = ${recipientBidx}
           AND received_at > now() - interval '24 hours'`,
  );
  return Number(rows[0]?.count ?? "0") > 0;
}

async function shopTemplate(shopId: string): Promise<string | null> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "outbound" }, async (db) => {
    return db.query<{ template_set: string | null }>(
      sql`SELECT template_set FROM app.shop_settings WHERE shop_id = ${shopId}`,
    );
  });
  return rows[0]?.template_set ?? null;
}

/** Flush all queued outbound messages for a shop in original order, each exactly once. */
export async function flushQueuedOutboundForShop(
  shopId: string,
  deps: OutboundDeps,
): Promise<void> {
  // Loop until no more claimable messages. Each call claims one, so this is serialized.
  for (let i = 0; i < 1000; i++) {
    const r = await processNextOutboundForShop(shopId, deps);
    if (r.state === "EMPTY") break;
  }
}

export async function processNextOutboundForShop(
  shopId: string,
  deps: OutboundDeps,
): Promise<OutboundResult> {
  const message = await claimNextOutbound(shopId);
  if (!message) return { processed: false, state: "EMPTY" };

  // Stale policy: a message queued longer than 24 hours is dead-lettered with an alert
  // and a seller notification; it is not silently dropped.
  const ageMs = Date.now() - message.queuedAt.getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    const reason = "queued longer than 24 hours";
    const state = await markFailed(shopId, message.id, reason);
    if (state === "DEAD") {
      await raiseOutboxStale(shopId, message.id);
      // notify seller
      try {
        if (message.recipientPhoneEnc) {
          const to = decryptField(message.recipientPhoneEnc, deps.keyRef, { shopId, table: "outbox_events", column: "recipient_phone_enc" });
          await deps.messaging.sendText({ to, text: "A queued message expired after 24 hours and was not sent." });
        }
      } catch { /* best effort */ }
    }
    return { processed: true, state, outboxId: message.id };
  }

  // 24-hour service window: if closed, prefer an approved utility template; otherwise
  // re-queue (never drop) until the recipient messages again.
  const windowOpen = await serviceWindowOpen(shopId, message.recipientPhoneBidx);
  if (!windowOpen) {
    const template = await shopTemplate(shopId);
    if (template) {
      try {
        if (!message.recipientPhoneEnc) throw new Error("MISSING_RECIPIENT_PHONE");
        const to = decryptField(message.recipientPhoneEnc, deps.keyRef, {
          shopId, table: "outbox_events", column: "recipient_phone_enc",
        });
        const payload = parsePayload(message.payload);
        const body = payload.body ?? payload.text ?? "";
        const result = await deps.messaging.sendTemplate({ to, templateName: template, language: "en", bodyParameters: [body] });
        await markSent(shopId, message.id, result.providerMessageId);
        return { processed: true, state: "SENT", outboxId: message.id };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const state = await markFailed(shopId, message.id, reason);
        if (state === "DEAD") await raiseOutboxDeadLetter(shopId, message.id, reason);
        return { processed: true, state, outboxId: message.id };
      }
    }
    // No template: re-queue without dropping.
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "outbound" }, async (db) => {
      await db.execute(
        sql`UPDATE app.outbox_events
               SET state = 'QUEUED', next_attempt_at = NULL, updated_at = now()
             WHERE id = ${message.id} AND shop_id = ${shopId}`,
      );
    });
    return { processed: true, state: "QUEUED", outboxId: message.id };
  }

  try {
    if (!message.recipientPhoneEnc) throw new Error("MISSING_RECIPIENT_PHONE");
    const to = decryptField(message.recipientPhoneEnc, deps.keyRef, {
      shopId,
      table: "outbox_events",
      column: "recipient_phone_enc",
    });

    const payload = parsePayload(message.payload);
    const body = payload.body ?? payload.text ?? "";
    const result =
      payload.buttons && payload.buttons.length > 0
        ? await deps.messaging.sendButtons({ to, body, buttons: payload.buttons })
        : await deps.messaging.sendText({ to, text: body });

    await markSent(shopId, message.id, result.providerMessageId);
    return { processed: true, state: "SENT", outboxId: message.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const state = await markFailed(shopId, message.id, reason);
    if (state === "DEAD") await raiseOutboxDeadLetter(shopId, message.id, reason);
    return { processed: true, state, outboxId: message.id };
  }
}
