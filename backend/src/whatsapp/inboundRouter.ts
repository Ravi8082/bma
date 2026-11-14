/**
 * Inbound router: claim one message for a seller, process it outside any transaction,
 * then record DONE or FAILED. No connection is held while parsing or while the seller
 * notification is composed.
 */

import { randomUUID } from "node:crypto";
import { env } from "../config/env";
import { encryptField } from "../crypto/fieldEncryption";
import { phoneBlindIndex } from "../crypto/blindIndex";
import { normalisePhone } from "../crypto/phone";
import { withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";
import { raiseInboxDeadLetter } from "./alerts";
import { cancelDraft, confirmDraft, formatPaise } from "./confirmation";
import { claimNextForShop, getInboxMessage, markDone, markFailed, type InboxMessage } from "./inbox";
import { enqueueOutbound, enqueueOutboundTx } from "./outbound";
import type { EntryParser } from "./parser";

export interface InboundDeps {
  parser: EntryParser;
  keyRef: string;
  blindIndexKey: string;
}

export type InboxOutcome = "DONE" | "FAILED" | "DEAD" | "EMPTY";

export interface InboxResult {
  processed: boolean;
  outcome: InboxOutcome;
  messageId?: string;
  error?: string;
}

function textBody(body: Record<string, unknown>): string | null {
  const text = body.text as { body?: unknown } | undefined;
  return typeof text?.body === "string" && text.body.trim().length > 0 ? text.body : null;
}

function senderPhone(body: Record<string, unknown>): string | null {
  const from = body.from;
  if (typeof from !== "string") return null;
  try {
    return normalisePhone(from);
  } catch {
    return null;
  }
}

function buttonId(body: Record<string, unknown>): string | null {
  const interactive = body.interactive as
    | { button_reply?: { id?: unknown }; list_reply?: { id?: unknown } }
    | undefined;
  const reply = interactive?.button_reply ?? interactive?.list_reply;
  if (typeof reply?.id === "string") return reply.id;
  const button = body.button as { payload?: unknown } | undefined;
  return typeof button?.payload === "string" ? button.payload : null;
}

function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

async function findOrCreateCustomer(
  db: TenantDb,
  shopId: string,
  name: string,
): Promise<string> {
  const normalized = normaliseName(name);
  const existing = await db.query<{ id: string }>(
    sql`SELECT id FROM app.customers
         WHERE shop_id = ${shopId} AND name_normalized = ${normalized}
         ORDER BY created_at
         LIMIT 1`,
  );
  const found = existing[0];
  if (found) return found.id;

  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, balance_paise)
        VALUES (${id}, ${shopId}, ${name.trim()}, ${normalized}, 0)`,
  );
  return id;
}

async function handleText(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const text = textBody(message.body);
  if (!text) throw new Error("EMPTY_TEXT");

  const parsed = deps.parser.parse(text, { maxAmountPaise: env.MAX_ENTRY_PAISE });
  if (!parsed) throw new Error(`EXTRACTION_FAILED: ${text.slice(0, 80)}`);

  const sellerPhone = senderPhone(message.body);
  if (!sellerPhone) throw new Error("MISSING_SELLER_PHONE");

  const sellerBidx = phoneBlindIndex(sellerPhone, deps.blindIndexKey);
  const sellerPhoneEnc = encryptField(sellerPhone, deps.keyRef, 1, {
    shopId: message.shopId,
    table: "entry_drafts",
    column: "seller_phone_enc",
  });

  await withTenant(
    { shopId: message.shopId, actorType: "WORKER", actorId: "inbound" },
    async (db) => {
      const customerId = await findOrCreateCustomer(db, message.shopId, parsed.customerName);

      const inserted = await db.query<{ id: string }>(
        sql`INSERT INTO app.entry_drafts
              (shop_id, source_message_id, wa_message_id, customer_id, customer_name, entry_type,
               direction, amount_paise, is_credit_sale, raw_text, source_tag, status,
               seller_phone_enc, seller_phone_bidx, key_version)
            VALUES
              (${message.shopId}, ${message.id}, ${message.waMessageId}, ${customerId},
               ${parsed.customerName}, ${parsed.entryType}, ${parsed.direction},
               ${parsed.amountPaise}, ${parsed.isCreditSale}, ${text.slice(0, 1000)}, 'SELLER',
               'PENDING', ${sellerPhoneEnc}, ${sellerBidx}, 1)
            ON CONFLICT (shop_id, source_message_id) DO NOTHING
            RETURNING id`,
      );

      const draft = inserted[0];
      // The draft and the confirmation are written in one transaction. If the draft already
      // exists, a previous attempt committed both, so do not enqueue a second confirmation.
      if (!draft) return;

      await enqueueOutboundTx(db, {
        shopId: message.shopId,
        recipientPhoneBidx: sellerBidx,
        recipientPhoneEnc: encryptField(sellerPhone, deps.keyRef, 1, {
          shopId: message.shopId,
          table: "outbox_events",
          column: "recipient_phone_enc",
        }),
        keyVersion: 1,
        messageType: "TEXT",
        payload: {
          to: sellerPhone,
          body:
            `New entry: ${formatPaise(parsed.amountPaise)} ${
              parsed.entryType === "PAYMENT_IN" ? "payment" : "credit sale"
            } for ${parsed.customerName}.\nConfirm or cancel.`,
          buttons: [
            { id: `confirm:${draft.id}`, title: "Confirm" },
            { id: `cancel:${draft.id}`, title: "Cancel" },
          ],
        },
      });
    },
  );
}

async function handleInteractive(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const id = buttonId(message.body);
  const match = id ? /^(confirm|cancel):([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (!match) throw new Error("UNKNOWN_INTERACTIVE_ACTION");
  const action = match[1];
  const draftId = match[2] ?? "";
  if (action === "confirm") {
    const result = await confirmDraft(message.shopId, draftId, { keyRef: deps.keyRef });
    // A Confirm must never be acknowledged before its draft exists. Processing it first is a
    // race, not success: leave the message retryable so the draft can catch up.
    if (result.status === "NOT_FOUND") throw new Error(`DRAFT_NOT_FOUND: ${draftId}`);
  } else {
    const result = await cancelDraft(message.shopId, draftId, { keyRef: deps.keyRef });
    if (result.status === "NOT_FOUND") throw new Error(`DRAFT_NOT_FOUND: ${draftId}`);
  }
}

async function handleMessage(message: InboxMessage, deps: InboundDeps): Promise<void> {
  switch (message.messageType) {
    case "TEXT":
      await handleText(message, deps);
      return;
    case "INTERACTIVE":
      await handleInteractive(message, deps);
      return;
    default:
      throw new Error(`UNSUPPORTED_MESSAGE_TYPE: ${message.messageType}`);
  }
}

async function notifySellerOfDeadLetter(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const sellerPhone = senderPhone(message.body);
  if (!sellerPhone) return;
  try {
    await enqueueOutbound({
      shopId: message.shopId,
      recipientPhoneBidx: phoneBlindIndex(sellerPhone, deps.blindIndexKey),
      recipientPhoneEnc: encryptField(sellerPhone, deps.keyRef, 1, {
        shopId: message.shopId,
        table: "outbox_events",
        column: "recipient_phone_enc",
      }),
      keyVersion: 1,
      messageType: "TEXT",
      payload: {
        to: sellerPhone,
        text:
          "We could not process your last message after 3 attempts. Please resend it or " +
          "contact support.",
      },
    });
  } catch {
    // The alert row is the durable record; a failed notification must not hide the DEAD state.
  }
}

/** Claim and process the oldest unfinished message for one seller. */
export async function processNextInboxMessageForShop(
  shopId: string,
  deps: InboundDeps,
): Promise<InboxResult> {
  const claimed = await claimNextForShop(shopId);
  if (!claimed) return { processed: false, outcome: "EMPTY" };

  const message = await getInboxMessage(claimed.id);
  if (!message) {
    const outcome = await markFailed(claimed.id, "message disappeared after claim");
    if (outcome === "DEAD") await raiseInboxDeadLetter(shopId, claimed.id, "message disappeared");
    return {
      processed: true,
      outcome,
      messageId: claimed.id,
      error: "message disappeared after claim",
    };
  }

  try {
    await handleMessage(message, deps);
    await markDone(claimed.id);
    return { processed: true, outcome: "DONE", messageId: claimed.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcome = await markFailed(claimed.id, reason);
    if (outcome === "DEAD") {
      await raiseInboxDeadLetter(shopId, claimed.id, reason);
      await notifySellerOfDeadLetter(message, deps);
    }
    return { processed: true, outcome, messageId: claimed.id, error: reason };
  }
}
