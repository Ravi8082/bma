/**
 * Outbound sender: claim a queued message, call the MessagingProvider outside any database
 * transaction, then record the result. The provider is the only place that knows whether it
 * is talking to Meta or the simulator.
 */

import { decryptField } from "../crypto/fieldEncryption";
import type { MessagingProvider } from "../integrations/messaging/types";
import { raiseOutboxDeadLetter } from "./alerts";
import { claimNextOutbound, markFailed, markSent, type OutboundState } from "./outbound";

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

export async function processNextOutboundForShop(
  shopId: string,
  deps: OutboundDeps,
): Promise<OutboundResult> {
  const message = await claimNextOutbound(shopId);
  if (!message) return { processed: false, state: "EMPTY" };

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
