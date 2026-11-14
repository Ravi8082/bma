/**
 * Draft confirmation, cancellation and ledger reversal.
 *
 * Approval posts exactly one ledger row in one transaction together with the draft status
 * update and the outbox confirmation. The ledger is append-only; undo is a REVERSAL row.
 */

import { randomUUID } from "node:crypto";
import { decryptField, encryptField } from "../crypto/fieldEncryption";
import { withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";
import { enqueueOutboundTx } from "./outbound";

export interface ConfirmationDeps {
  keyRef: string;
}

export type ConfirmStatus = "CONFIRMED" | "ALREADY_CONFIRMED" | "CANCELLED" | "NOT_FOUND";

export interface ConfirmResult {
  status: ConfirmStatus;
  entryId: string | null;
}

export type CancelStatus = "CANCELLED" | "ALREADY_CANCELLED" | "CONFIRMED" | "NOT_FOUND";

export interface CancelResult {
  status: CancelStatus;
  entryId: string | null;
}

interface DraftRow {
  id: string;
  shop_id: string;
  wa_message_id: string;
  customer_id: string | null;
  customer_name: string;
  entry_type: string;
  direction: string;
  amount_paise: string;
  is_credit_sale: boolean;
  seller_phone_enc: Buffer;
  seller_phone_bidx: Buffer;
  key_version: number;
  status: string;
  confirmed_entry_id: string | null;
}

interface LedgerRow {
  id: string;
  customer_id: string | null;
  entry_type: string;
  direction: string;
  amount_paise: string;
  occurred_at: Date;
}

function contextFor(shopId: string): { shopId: string; actorType: "USER"; actorId: string } {
  return { shopId, actorType: "USER", actorId: "seller" };
}

/** Integer-only rupee display. No float arithmetic touches a monetary value. */
export function formatPaise(amountPaise: number | string): string {
  const value = typeof amountPaise === "string" ? Number.parseInt(amountPaise, 10) : amountPaise;
  const digits = String(value).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return fraction === "00" ? `₹${whole}` : `₹${whole}.${fraction}`;
}

function draftSummary(draft: DraftRow): string {
  const kind = draft.entry_type === "PAYMENT_IN" ? "payment" : "credit sale";
  return `${formatPaise(draft.amount_paise)} ${kind} for ${draft.customer_name}`;
}

async function sendSellerText(
  db: TenantDb,
  draft: DraftRow,
  text: string,
  deps: ConfirmationDeps,
): Promise<void> {
  const sellerPhone = decryptField(draft.seller_phone_enc, deps.keyRef, {
    shopId: draft.shop_id,
    table: "entry_drafts",
    column: "seller_phone_enc",
  });
  const recipientPhoneEnc = encryptField(sellerPhone, deps.keyRef, draft.key_version, {
    shopId: draft.shop_id,
    table: "outbox_events",
    column: "recipient_phone_enc",
  });
  await enqueueOutboundTx(db, {
    shopId: draft.shop_id,
    recipientPhoneBidx: draft.seller_phone_bidx,
    recipientPhoneEnc,
    keyVersion: draft.key_version,
    messageType: "TEXT",
    payload: { to: sellerPhone, text },
  });
}

function balanceDelta(entryType: string, direction: string, amountPaise: number): number {
  if (entryType === "SALE" && direction === "DEBIT") return amountPaise;
  if (entryType === "PAYMENT_IN" && direction === "CREDIT") return -amountPaise;
  return 0;
}

/**
 * Confirm one draft. Safe to call twice: the second call returns ALREADY_CONFIRMED and
 * posts nothing.
 */
export async function confirmDraft(
  shopId: string,
  draftId: string,
  deps: ConfirmationDeps,
): Promise<ConfirmResult> {
  return withTenant(contextFor(shopId), async (db) => {
    const draft = await db.queryOne<DraftRow>(
      sql`SELECT id, shop_id, wa_message_id, customer_id, customer_name, entry_type, direction,
                 amount_paise, is_credit_sale, seller_phone_enc, seller_phone_bidx, key_version,
                 status, confirmed_entry_id
            FROM app.entry_drafts
           WHERE shop_id = ${shopId} AND id = ${draftId}
           FOR UPDATE`,
    );
    if (!draft) return { status: "NOT_FOUND", entryId: null };
    if (draft.status === "CONFIRMED") {
      return { status: "ALREADY_CONFIRMED", entryId: draft.confirmed_entry_id };
    }
    if (draft.status === "CANCELLED") return { status: "CANCELLED", entryId: null };

    const idempotencyKey = `draft-confirm:${draftId}`;
    const entryId = randomUUID();
    const amount = Number.parseInt(draft.amount_paise, 10);

    const inserted = await db.query<{ id: string }>(
      sql`INSERT INTO app.ledger_entries
            (id, shop_id, customer_id, posting_id, entry_seq, entry_type, direction,
             amount_paise, occurred_at, description, source, source_id, idempotency_key, created_by)
          VALUES
            (${entryId}, ${shopId}, ${draft.customer_id}, ${draftId}, 1, ${draft.entry_type},
             ${draft.direction}, ${draft.amount_paise}, now(), ${draftSummary(draft)}, 'WHATSAPP',
             ${draft.wa_message_id}, ${idempotencyKey}, 'seller')
          ON CONFLICT (shop_id, idempotency_key) DO NOTHING
          RETURNING id`,
    );

    let finalEntryId = inserted[0]?.id ?? null;
    if (!finalEntryId) {
      const existing = await db.queryOne<{ id: string }>(
        sql`SELECT id FROM app.ledger_entries
             WHERE shop_id = ${shopId} AND idempotency_key = ${idempotencyKey}`,
      );
      finalEntryId = existing?.id ?? null;
    }
    if (!finalEntryId) throw new Error("ledger insert did not return an entry");

    await db.execute(
      sql`UPDATE app.entry_drafts
             SET status = 'CONFIRMED', confirmed_entry_id = ${finalEntryId}, confirmed_at = now()
           WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`,
    );

    const delta = balanceDelta(draft.entry_type, draft.direction, amount);
    if (delta !== 0 && draft.customer_id) {
      await db.execute(
        sql`UPDATE app.customers
               SET balance_paise = balance_paise + ${delta}
             WHERE shop_id = ${shopId} AND id = ${draft.customer_id}`,
      );
    }

    await sendSellerText(
      db,
      draft,
      `✅ Entry confirmed: ${draftSummary(draft)}. Entry ${finalEntryId.slice(0, 8)}.`,
      deps,
    );

    return { status: "CONFIRMED", entryId: finalEntryId };
  });
}

/** Cancel a pending draft. A confirmed draft must be undone with a reversal instead. */
export async function cancelDraft(
  shopId: string,
  draftId: string,
  deps: ConfirmationDeps,
): Promise<CancelResult> {
  return withTenant(contextFor(shopId), async (db) => {
    const draft = await db.queryOne<DraftRow>(
      sql`SELECT id, shop_id, wa_message_id, customer_id, customer_name, entry_type, direction,
                 amount_paise, is_credit_sale, seller_phone_enc, seller_phone_bidx, key_version,
                 status, confirmed_entry_id
            FROM app.entry_drafts
           WHERE shop_id = ${shopId} AND id = ${draftId}
           FOR UPDATE`,
    );
    if (!draft) return { status: "NOT_FOUND", entryId: null };
    if (draft.status === "CONFIRMED") {
      return { status: "CONFIRMED", entryId: draft.confirmed_entry_id };
    }
    if (draft.status === "CANCELLED") return { status: "ALREADY_CANCELLED", entryId: null };

    await db.execute(
      sql`UPDATE app.entry_drafts
             SET status = 'CANCELLED', cancelled_at = now()
           WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`,
    );

    await sendSellerText(db, draft, `Entry cancelled: ${draftSummary(draft)}.`, deps);
    return { status: "CANCELLED", entryId: null };
  });
}

export interface ReverseResult {
  reversalEntryId: string;
}

/** A second undo of the same entry is rejected, not silently treated as success. */
export class EntryAlreadyReversedError extends Error {
  readonly code = "ENTRY_ALREADY_REVERSED";

  constructor(entryId: string) {
    super(`ledger entry ${entryId} is already reversed`);
    this.name = "EntryAlreadyReversedError";
  }
}

/**
 * Undo a posted ledger entry by appending a REVERSAL row. The original row is untouched.
 * The partial unique index allows exactly one reversal per entry, so a second undo is
 * rejected with `EntryAlreadyReversedError` instead of writing another reversal.
 */
export async function reverseLedgerEntry(
  shopId: string,
  entryId: string,
  reason: string,
): Promise<ReverseResult> {
  return withTenant(contextFor(shopId), async (db) => {
    const original = await db.queryOne<LedgerRow>(
      sql`SELECT id, customer_id, entry_type, direction, amount_paise, occurred_at
            FROM app.ledger_entries
           WHERE shop_id = ${shopId} AND id = ${entryId}`,
    );
    if (!original) throw new Error("ledger entry not found");
    if (original.entry_type === "REVERSAL") throw new Error("cannot reverse a reversal");

    const existing = await db.queryOne<{ id: string }>(
      sql`SELECT id FROM app.ledger_entries
           WHERE shop_id = ${shopId} AND reverses_entry_id = ${entryId}`,
    );
    if (existing) throw new EntryAlreadyReversedError(entryId);

    const reversalId = randomUUID();
    const opposite = original.direction === "DEBIT" ? "CREDIT" : "DEBIT";
    const amount = Number.parseInt(original.amount_paise, 10);

    // ON CONFLICT closes the concurrent-double-undo window: the loser of the unique-index
    // race gets no row back and is rejected below, rather than surfacing a raw 23505.
    const inserted = await db.query<{ id: string }>(
      sql`INSERT INTO app.ledger_entries
            (id, shop_id, customer_id, posting_id, entry_seq, entry_type, direction,
             amount_paise, occurred_at, description, source, source_id, idempotency_key,
             created_by, reverses_entry_id)
          VALUES
            (${reversalId}, ${shopId}, ${original.customer_id}, ${randomUUID()}, 1, 'REVERSAL',
             ${opposite}, ${original.amount_paise}, now(), ${reason.slice(0, 500)}, 'WHATSAPP',
             ${original.id}, ${`reversal:${entryId}`}, 'seller', ${entryId})
          ON CONFLICT DO NOTHING
          RETURNING id`,
    );
    if (!inserted[0]) throw new EntryAlreadyReversedError(entryId);

    const delta = balanceDelta(original.entry_type, original.direction, amount);
    if (delta !== 0 && original.customer_id) {
      await db.execute(
        sql`UPDATE app.customers
               SET balance_paise = balance_paise - ${delta}
             WHERE shop_id = ${shopId} AND id = ${original.customer_id}`,
      );
    }

    await db.execute(
      sql`INSERT INTO app.audit_logs
            (shop_id, actor_type, actor_id, action, entity_type, entity_id, reason)
          VALUES
            (${shopId}, 'USER', 'seller', 'LEDGER_REVERSAL', 'ledger_entry', ${entryId}, ${reason.slice(0, 500)})`,
    );

    return { reversalEntryId: reversalId };
  });
}
