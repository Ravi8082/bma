/**
 * Inbound router: claim one message for a seller, process it outside any transaction,
 * then record DONE or FAILED. No connection is held while parsing or while the seller
 * notification is composed.
 */


import { env } from "../config/env";
import { encryptField } from "../crypto/fieldEncryption";
import { phoneBlindIndex } from "../crypto/blindIndex";
import { normalisePhone } from "../crypto/phone";
import { withTenant } from "../db/tenant";
import type { MessagingProvider } from "../integrations/messaging/types";
import { sql } from "../db/sql";
import { raiseInboxDeadLetter, raiseOutboxStale } from "./alerts";
import { cancelDraft, confirmDraft, formatPaise, reverseLedgerEntry, EntryAlreadyReversedError } from "./confirmation";
import { needsReconsent, getLatestConsentVersion, recordConsent, reconsentAlreadySentToday, consentDeclinedRecently } from "../modules/onboarding/consent";
import { findOrCreateCustomer as findOrCreateCustomerModule } from "../modules/customers/customers";
import { claimNextForShop, getInboxMessage, markDone, markFailed, type InboxMessage } from "./inbox";
import { enqueueOutbound, enqueueOutboundTx } from "./outbound";
import { queueSummaryTx, hasQueuedSummarySince, supersedeQueuedSummaries } from "./eveningScheduler";
import { batchEntryVersions, confirmAllBatch, reviewBatchPage } from "./batch";
import { claimPilotCapNotice, getPilotSpend, pilotCapBreach, pilotCapsFor, PILOT_CAP_MESSAGE } from "./pilotBudget";
import { flushQueuedOutboundForShop } from "./outboundSender";
import { deterministicParser, type EntryParser, type ParsedEntry } from "./parser";
import { parseMoneyToken } from "./parser";

export interface InboundDeps {
  parser: EntryParser;
  keyRef: string;
  blindIndexKey: string;
  messaging?: MessagingProvider;
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

/** Best-effort plain-text reply to the seller for a refused command. */
async function replyToSeller(
  message: InboxMessage,
  deps: InboundDeps,
  text: string,
  buttons?: { id: string; title: string }[],
): Promise<void> {
  const phone = senderPhone(message.body);
  if (!phone) return;
  const bidx = phoneBlindIndex(phone, deps.blindIndexKey);
  await withTenant(
    { shopId: message.shopId, actorType: "WORKER", actorId: "inbound" },
    async (db) => {
      await enqueueOutboundTx(db, {
        shopId: message.shopId,
        recipientPhoneBidx: bidx,
        recipientPhoneEnc: encryptField(phone, deps.keyRef, 1, {
          shopId: message.shopId,
          table: "outbox_events",
          column: "recipient_phone_enc",
        }),
        keyVersion: 1,
        messageType: "TEXT",
        payload: buttons ? { to: phone, text, buttons } : { to: phone, text },
      });
    },
  );
}

/** Send one page of a batch review with the Confirm-all / Next tap targets. */
async function sendReviewPage(
  message: InboxMessage,
  deps: InboundDeps,
  batchId: string,
  page: number,
): Promise<void> {
  const pageSize = 5;
  const review = await reviewBatchPage(message.shopId, batchId, page, pageSize);
  if (review.total === 0) {
    await replyToSeller(message, deps, "That summary has no entries.");
    return;
  }

  const pages = Math.max(1, Math.ceil(review.total / pageSize));
  const lines = [`Review (page ${page + 1} of ${pages}):`];
  for (const entry of review.entries) {
    const kind = entry.entry_type === "PAYMENT_IN" ? "payment" : "credit sale";
    lines.push(
      `${formatPaise(entry.amount_paise)} ${kind} for ${entry.customer_name} (${entry.status.toLowerCase()})`,
    );
  }

  const buttons = [{ id: `confirm_all:${batchId}`, title: "Confirm all" }];
  if (page + 1 < pages) {
    buttons.push({ id: `review_page:${batchId}:${page + 1}`, title: "Next" });
  }
  await replyToSeller(message, deps, lines.join("\n"), buttons);
}

/**
 * Undo via the append-only ledger. A second undo or an entry id that does not belong to
 * this shop is answered politely instead of failing the inbox message into a retry loop.
 */
async function undoPolitely(
  message: InboxMessage,
  entryId: string,
  deps: InboundDeps,
): Promise<void> {
  try {
    await reverseLedgerEntry(message.shopId, entryId, "seller undo");
  } catch (error) {
    if (error instanceof EntryAlreadyReversedError) {
      await replyToSeller(message, deps, "That entry is already undone.");
      return;
    }
    if (error instanceof Error && error.message === "ledger entry not found") {
      await replyToSeller(message, deps, "I could not find that entry, please send it again.");
      return;
    }
    throw error;
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

// Customer matching is delegated to modules/customers/customers.ts so ambiguity is
// handled consistently (no auto-pick). findOrCreateCustomerModule is imported above.

/**
 * Pick the parser for this message.
 *
 * A shop that has hit its free-pilot AI ceiling is switched to the deterministic
 * parser and told once per period. A failure in the budget check also prefers the
 * free parser: the cap must never be the reason an entry is dropped.
 */
async function parserForMessage(message: InboxMessage, deps: InboundDeps): Promise<EntryParser> {
  if (typeof deps.parser.parseAsync !== "function") return deps.parser;

  try {
    const spend = await getPilotSpend(message.shopId);
    const breach = pilotCapBreach(spend, await pilotCapsFor(message.shopId));
    if (!breach) return deps.parser;

    try {
      if (await claimPilotCapNotice(message.shopId, breach)) {
        await replyToSeller(message, deps, PILOT_CAP_MESSAGE);
      }
    } catch {
      // The notice is best effort; the seller's entry still proceeds.
    }
    return deterministicParser;
  } catch {
    return deterministicParser;
  }
}

async function handleText(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const text = textBody(message.body);
  if (!text) throw new Error("EMPTY_TEXT");

  // Check for a pending edit in the DB (survives restarts, expires after 2 minutes).
  const pendingRow = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
    const rows = await db.query<{ id: string; draft_id: string; field: string; expires_at: Date }>(
      sql`SELECT id, draft_id, field, expires_at FROM app.pending_edits WHERE shop_id = ${message.shopId} AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  });

  if (pendingRow) {
    // If the message parses as a new entry, ask once instead of treating it as the edit value.
    // The pending edit is dropped so the seller's repeat is processed as a new entry.
    const parsed = deps.parser.parse(text, { maxAmountPaise: env.MAX_ENTRY_PAISE });
    if (parsed.kind === "PARSED" || parsed.kind === "MULTI") {
      await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
        await db.execute(sql`DELETE FROM app.pending_edits WHERE shop_id = ${message.shopId} AND id = ${pendingRow.id}`);
      });
      await replyToSeller(message, deps, "Is this the new amount for the draft, or a new entry?");
      return;
    }
    if (pendingRow.field === "amount") {
      const amt = parseMoneyToken(text);
      // Integer paise only. A zero, negative, non-numeric or above-ceiling value is refused
      // and the pending edit stays open so the seller can answer again.
      if (amt === null || amt >= env.MAX_ENTRY_PAISE) {
        await replyToSeller(message, deps, "That amount doesn't look right. Send a number like 500.");
        return;
      }
    }
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      await db.execute(sql`DELETE FROM app.pending_edits WHERE shop_id = ${message.shopId} AND id = ${pendingRow.id}`);
      if (pendingRow.field === "name") {
        await db.execute(sql`UPDATE app.entry_drafts SET customer_name = ${text} WHERE shop_id = ${message.shopId} AND id = ${pendingRow.draft_id} AND status = 'PENDING'`);
      } else if (pendingRow.field === "amount") {
        const amt = parseMoneyToken(text);
        if (amt !== null) {
          await db.execute(sql`UPDATE app.entry_drafts SET amount_paise = ${amt} WHERE shop_id = ${message.shopId} AND id = ${pendingRow.draft_id} AND status = 'PENDING'`);
        }
      } else if (pendingRow.field === "type") {
        const isCredit = /credit|udhaar|udhar/i.test(text);
        await db.execute(sql`UPDATE app.entry_drafts
               SET is_credit_sale = ${isCredit},
                   type_unclear = false,
                   entry_type = CASE WHEN ${isCredit} THEN 'SALE' ELSE entry_type END,
                   direction = CASE WHEN ${isCredit} THEN direction ELSE 'CREDIT' END
             WHERE shop_id = ${message.shopId} AND id = ${pendingRow.draft_id} AND status = 'PENDING'`);
      }
    });
    return;
  }

  const sellerPhone = senderPhone(message.body);
  if (!sellerPhone) throw new Error("MISSING_SELLER_PHONE");
  const sellerBidx = phoneBlindIndex(sellerPhone, deps.blindIndexKey);

  // Seller-facing on-demand summary. Independent of the undo/edit flag: it only reads
  // pending drafts and queues the same message the evening scheduler sends, so the seller
  // can trigger it manually during onboarding or a live test.
  if (/^(summary|hisaab|hisab|हिसाब)$/iu.test(text.trim())) {
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      const summary = await queueSummaryTx(
        db,
        message.shopId,
        { phone: sellerPhone, bidx: sellerBidx },
        deps.keyRef,
      );
      if (!summary.queued) {
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
          payload: { to: sellerPhone, text: "No pending entries today." },
        });
      }
    });
    return;
  }

  // Feature flag: undo/edit disabled by default per shop.
  const undoEditEnabled = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
    const rows = await db.query<{ undo_edit_enabled: boolean }>(sql`SELECT undo_edit_enabled FROM app.shop_settings WHERE shop_id = ${message.shopId}`);
    return rows[0]?.undo_edit_enabled ?? false;
  });
  if (!undoEditEnabled && (/^undo$/i.test(text.trim()) || /^edit\s/i.test(text.trim()))) {
    const sp = sellerPhone;
    const bidx = phoneBlindIndex(sp, deps.blindIndexKey);
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      const enc = encryptField(sp, deps.keyRef, 1, { shopId: message.shopId, table: "outbox_events", column: "recipient_phone_enc" });
      await enqueueOutboundTx(db, { shopId: message.shopId, recipientPhoneBidx: bidx, recipientPhoneEnc: enc, keyVersion: 1, messageType: "TEXT", payload: { to: sp, text: "Undo/Edit is not enabled for this shop." } });
    });
    return;
  }

  // Seller-facing undo command: show which entry will be reversed, needs a tap.
  if (/^undo$/i.test(text.trim())) {
    const entry = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      const rows = await db.query<{ id: string; confirmed_entry_id: string | null; customer_name: string; amount_paise: string; entry_type: string }>(
        sql`SELECT id, confirmed_entry_id, customer_name, amount_paise, entry_type FROM app.entry_drafts WHERE shop_id = ${message.shopId} AND status = 'CONFIRMED' ORDER BY confirmed_at DESC LIMIT 1`,
      );
      return rows[0] ?? null;
    });
    if (entry && entry.confirmed_entry_id) {
      await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
        const enc = encryptField(sellerPhone, deps.keyRef, 1, { shopId: message.shopId, table: "outbox_events", column: "recipient_phone_enc" });
        await enqueueOutboundTx(db, {
          shopId: message.shopId,
          recipientPhoneBidx: sellerBidx,
          recipientPhoneEnc: enc,
          keyVersion: 1,
          messageType: "TEXT",
          payload: {
            to: sellerPhone,
            body: `Undo ${entry.amount_paise} ${entry.entry_type} for ${entry.customer_name}? Tap to confirm.`,
            buttons: [{ id: `undo_confirm:${entry.confirmed_entry_id}`, title: "Undo" }],
          },
        });
      });
    }
    return;
  }

  // interactive undo confirm
  // (handled in handleInteractive below via undo_confirm button)

  const activeParser = await parserForMessage(message, deps);
  const parseResult =
    typeof activeParser.parseAsync === "function"
      ? await activeParser.parseAsync!(text, { maxAmountPaise: env.MAX_ENTRY_PAISE })
      : activeParser.parse(text, { maxAmountPaise: env.MAX_ENTRY_PAISE });

  if (parseResult.kind === "NOT_AN_ENTRY") {
    throw new Error(`EXTRACTION_FAILED: ${text.slice(0, 80)}`);
  }
  if (parseResult.kind === "NEEDS_CLARIFICATION") {
    // Send a specific clarification question with tap options.
    const sellerPhone = senderPhone(message.body);
    if (sellerPhone) {
      const sellerBidx = phoneBlindIndex(sellerPhone, deps.blindIndexKey);
      await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
        await enqueueOutboundTx(db, {
          shopId: message.shopId,
          recipientPhoneBidx: sellerBidx,
          recipientPhoneEnc: encryptField(sellerPhone, deps.keyRef, 1, { shopId: message.shopId, table: "outbox_events", column: "recipient_phone_enc" }),
          keyVersion: 1,
          messageType: "TEXT",
          payload: {
            to: sellerPhone,
            text: `Clarification needed: ${parseResult.reason}. Please reply.`,
            buttons: parseResult.options.map((o, i) => ({ id: `clarify:${i}:${o}`, title: o.slice(0, 20) })),
          },
        });
      });
    }
    return; // no draft; message already marked DONE by caller
  }
  const entries: ParsedEntry[] = parseResult.kind === "MULTI" ? parseResult.entries : [ (parseResult as { kind: "PARSED"; entry: ParsedEntry }).entry ];

  if (!sellerPhone) throw new Error("MISSING_SELLER_PHONE");

  const sellerPhoneEnc = encryptField(sellerPhone, deps.keyRef, 1, {
    shopId: message.shopId,
    table: "entry_drafts",
    column: "seller_phone_enc",
  });

  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    const parsed = entries[entryIdx]!;
    await withTenant(
      { shopId: message.shopId, actorType: "WORKER", actorId: "inbound" },
      async (db) => {
        const customerMatch = await findOrCreateCustomerModule(db, message.shopId, parsed.customerName, deps.blindIndexKey);
      const customerId = customerMatch.customerId;
      const customerAmbiguous = customerMatch.ambiguous;

      const inlinePhoneEnc = parsed.sellerPhone
        ? encryptField(parsed.sellerPhone, deps.keyRef, 1, { shopId: message.shopId, table: "entry_drafts", column: "customer_phone_enc" })
        : null;
      const inlinePhoneBidx = parsed.sellerPhone ? phoneBlindIndex(parsed.sellerPhone, deps.blindIndexKey) : null;
      const inserted = await db.query<{ id: string }>(
        sql`INSERT INTO app.entry_drafts
              (shop_id, source_message_id, wa_message_id, customer_id, customer_name, entry_type,
               direction, amount_paise, is_credit_sale, raw_text, source_tag, status,
               seller_phone_enc, seller_phone_bidx, key_version, type_unclear,
               customer_phone_enc, customer_phone_bidx, entry_index)
            VALUES
              (${message.shopId}, ${message.id}, ${message.waMessageId}, ${customerId},
               ${parsed.customerName}, ${parsed.entryType}, ${parsed.direction},
               ${parsed.amountPaise}, ${parsed.isCreditSale}, ${text.slice(0, 1000)}, 'SELLER',
               'PENDING', ${sellerPhoneEnc}, ${sellerBidx}, 1, ${parsed.typeUnclear},
               ${inlinePhoneEnc}, ${inlinePhoneBidx}, ${entryIdx})
            ON CONFLICT (shop_id, source_message_id, entry_index) DO NOTHING
            RETURNING id`,
      );

      const draft = inserted[0];
      // The draft and the confirmation are written in one transaction. If the draft already
      // exists, a previous attempt committed both, so do not enqueue a second confirmation.
      if (!draft) return;

      if (customerAmbiguous) {
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
            text: `Multiple customers named ${parsed.customerName}. Reply with a distinguishing label or phone number.`,
          },
        });
      }

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
            } for ${parsed.customerName}.${parsed.sellerPhone ? `\nPhone: ${parsed.sellerPhone}` : ""}\nConfirm or cancel.`,
          buttons: parsed.typeUnclear
            ? [
                { id: `resolve_credit:${draft.id}`, title: "Credit" },
                { id: `resolve_cash:${draft.id}`, title: "Cash" },
                { id: `cancel:${draft.id}`, title: "Cancel" },
              ]
            : [
                { id: `confirm:${draft.id}`, title: "Confirm" },
                { id: `edit:${draft.id}`, title: "Edit" },
                { id: `cancel:${draft.id}`, title: "Cancel" },
              ],
        },
      });
    },
  );
  }
}

async function handleInteractive(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const id = buttonId(message.body);
  if (id === "consent:yes" || id === "consent:no") {
    const granted = id === "consent:yes";
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      const users = await db.query<{ id: string }>(sql`SELECT id FROM app.users WHERE shop_id = ${message.shopId} AND role = 'OWNER' ORDER BY created_at LIMIT 1`);
      const userId = users[0]?.id;
      if (userId) await recordConsent(message.shopId, userId, granted, granted ? "privacy-v2" : "declined");
    });
    return;
  }
  // Per-shop feature flag: undo/edit are off by default. Refuse both the text commands
  // (handled in handleText) and the interactive taps politely.
  const undoEditEnabled = await withTenant(
    { shopId: message.shopId, actorType: "WORKER", actorId: "inbound" },
    async (db) => {
      const rows = await db.query<{ undo_edit_enabled: boolean }>(
        sql`SELECT undo_edit_enabled FROM app.shop_settings WHERE shop_id = ${message.shopId}`,
      );
      return rows[0]?.undo_edit_enabled ?? false;
    },
  );
  if (!undoEditEnabled && id && /^(undo_confirm|undo_final|edit)(:|_)/.test(id)) {
    await replyToSeller(message, deps, "Undo/Edit is not enabled for this shop.");
    return;
  }

  const resolveMatch = id ? /^resolve_(credit|cash):([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (resolveMatch) {
    const choice = resolveMatch[1];
    const draftId = resolveMatch[2] ?? "";
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      await db.execute(sql`UPDATE app.entry_drafts
             SET type_unclear = false,
                 is_credit_sale = ${choice === "credit"},
                 entry_type = CASE WHEN ${choice === "credit"} THEN 'SALE' ELSE entry_type END,
                 direction = CASE WHEN ${choice === "cash"} THEN 'CREDIT' ELSE direction END
           WHERE shop_id = ${message.shopId} AND id = ${draftId} AND status = 'PENDING'`);
    });
    return;
  }
  const editPickMatch = id ? /^edit_(name|amount|type):([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (editPickMatch) {
    const field = editPickMatch[1]!;
    const draftId = editPickMatch[2]!;
    const draft = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      return db.queryOne<{ id: string; status: string }>(
        sql`SELECT id, status FROM app.entry_drafts WHERE shop_id = ${message.shopId} AND id = ${draftId}`,
      );
    });
    if (!draft) {
      await replyToSeller(message, deps, "I could not find that entry, please send it again.");
      return;
    }
    if (draft.status !== "PENDING") {
      await replyToSeller(message, deps, "That entry is already confirmed. Undo it first.");
      return;
    }
    await replyToSeller(message, deps, `Send new ${field}.`);
    await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      // One active edit per shop: a double tap replaces the previous prompt instead of
      // leaving two rows that the next message would have to choose between.
      await db.execute(sql`DELETE FROM app.pending_edits WHERE shop_id = ${message.shopId}`);
      await db.execute(sql`INSERT INTO app.pending_edits (shop_id, draft_id, field, expires_at) VALUES (${message.shopId}, ${draftId}, ${field}, now() + interval '2 minutes')`);
    });
    return;
  }

  const editMatch2 = id ? /^edit:([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (editMatch2) {
    const draftId = editMatch2[1]!;
    const draft = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      return db.queryOne<{ id: string; status: string }>(
        sql`SELECT id, status FROM app.entry_drafts WHERE shop_id = ${message.shopId} AND id = ${draftId}`,
      );
    });
    if (!draft) {
      await replyToSeller(message, deps, "I could not find that entry, please send it again.");
      return;
    }
    if (draft.status !== "PENDING") {
      await replyToSeller(message, deps, "That entry is already confirmed. Undo it first.");
      return;
    }
    const sellerPhone2 = senderPhone(message.body);
    if (sellerPhone2) {
      const bidx2 = phoneBlindIndex(sellerPhone2, deps.blindIndexKey);
      await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
        const enc = encryptField(sellerPhone2, deps.keyRef, 1, { shopId: message.shopId, table: "outbox_events", column: "recipient_phone_enc" });
        await enqueueOutboundTx(db, {
          shopId: message.shopId,
          recipientPhoneBidx: bidx2,
          recipientPhoneEnc: enc,
          keyVersion: 1,
          messageType: "TEXT",
          payload: {
            to: sellerPhone2,
            text: "What to change?",
            buttons: [
              { id: `edit_name:${draftId}`, title: "Name" },
              { id: `edit_amount:${draftId}`, title: "Amount" },
              { id: `edit_type:${draftId}`, title: "Type" },
            ],
          },
        });
      });
    }
    return;
  }

  const undoMatch2 = id ? /^undo_confirm:([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (undoMatch2) {
    const entryId = undoMatch2[1] ?? "";
    // extra confirmation for old/large entries
    const entry = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
      return db.queryOne<{ id: string; confirmed_entry_id: string | null; amount_paise: string; confirmed_at: Date }>(
        sql`SELECT id, confirmed_entry_id, amount_paise, confirmed_at FROM app.entry_drafts WHERE shop_id = ${message.shopId} AND confirmed_entry_id = ${entryId}`,
      );
    });
    if (entry) {
      const settings = await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
        return db.query<{ undo_extra_confirm_age_ms: number; undo_extra_confirm_amount_paise: string }>(sql`SELECT undo_extra_confirm_age_ms, undo_extra_confirm_amount_paise FROM app.shop_settings WHERE shop_id = ${message.shopId}`);
      });
      const ageThreshold = settings[0]?.undo_extra_confirm_age_ms ?? 86400000;
      const amtThreshold = Number.parseInt(settings[0]?.undo_extra_confirm_amount_paise ?? "1000000", 10);
      const age = Date.now() - new Date(entry.confirmed_at).getTime();
      const amt = Number.parseInt(entry.amount_paise, 10);
      const extra = age > ageThreshold || amt > amtThreshold;
      if (extra) {
        const sellerPhone2 = senderPhone(message.body);
        if (sellerPhone2) {
          const bidx2 = phoneBlindIndex(sellerPhone2, deps.blindIndexKey);
          await withTenant({ shopId: message.shopId, actorType: "WORKER", actorId: "inbound" }, async (db) => {
            const enc = encryptField(sellerPhone2, deps.keyRef, 1, { shopId: message.shopId, table: "outbox_events", column: "recipient_phone_enc" });
            await enqueueOutboundTx(db, {
              shopId: message.shopId,
              recipientPhoneBidx: bidx2,
              recipientPhoneEnc: enc,
              keyVersion: 1,
              messageType: "TEXT",
              payload: {
                to: sellerPhone2,
                body: `Undo ${entry.amount_paise} entry? Confirm again.`,
                buttons: [{ id: `undo_final:${entryId}`, title: "Confirm undo" }],
              },
            });
          });
        }
        return;
      }
    }
    await undoPolitely(message, entryId, deps);
    return;
  }

  const undoFinalMatch = id ? /^undo_final:([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (undoFinalMatch) {
    await undoPolitely(message, undoFinalMatch[1] ?? "", deps);
    return;
  }

  // Evening summary: Confirm all posts each pending entry exactly once. A repeated tap
  // finds the drafts already CONFIRMED and posts nothing further.
  const confirmAllMatch = id ? /^confirm_all:([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (confirmAllMatch) {
    const batchId = confirmAllMatch[1] ?? "";
    const versions = await batchEntryVersions(message.shopId, batchId);
    if (versions.length === 0) {
      await replyToSeller(message, deps, "That summary is no longer available.");
      return;
    }
    const expected: Record<string, number> = {};
    for (const version of versions) expected[version.draftId] = version.version;

    const result = await confirmAllBatch(message.shopId, batchId, { keyRef: deps.keyRef }, expected);
    const parts = [
      `Confirmed ${result.confirmed} ${result.confirmed === 1 ? "entry" : "entries"} totalling ${formatPaise(result.totalPaise)}.`,
    ];
    if (result.skipped > 0) parts.push(`${result.skipped} skipped (needs a type or already confirmed).`);
    if (result.failed > 0) parts.push(`${result.failed} could not be confirmed; please review again.`);
    await replyToSeller(message, deps, parts.join(" "));
    return;
  }

  const reviewMatch = id ? /^review:([0-9a-fA-F-]{36})$/.exec(id) : null;
  if (reviewMatch) {
    await sendReviewPage(message, deps, reviewMatch[1] ?? "", 0);
    return;
  }

  const reviewPageMatch = id ? /^review_page:([0-9a-fA-F-]{36}):(\d{1,3})$/.exec(id) : null;
  if (reviewPageMatch) {
    await sendReviewPage(message, deps, reviewPageMatch[1] ?? "", Number(reviewPageMatch[2] ?? "0"));
    return;
  }

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

async function handleUnsupported(message: InboxMessage, deps: InboundDeps): Promise<void> {
  const isGroup = message.messageType === "GROUP";
  const sellerPhone = senderPhone(message.body);

  await withTenant(
    { shopId: message.shopId, actorType: "WORKER", actorId: "inbound" },
    async (db) => {
      await db.execute(
        sql`INSERT INTO app.audit_logs
              (shop_id, actor_type, actor_id, action, entity_type, entity_id, after)
            VALUES
              (${message.shopId}, 'SYSTEM', 'inbound',
               ${isGroup ? "GROUP_MESSAGE_IGNORED" : "UNSUPPORTED_MESSAGE_TYPE"},
               'inbox_message', ${message.id},
               ${JSON.stringify({ messageType: message.messageType })}::jsonb)`,
      );

      // Groups have no individual seller to reply to; ignore them.
      if (isGroup || !sellerPhone) return;

      const sellerBidx = phoneBlindIndex(sellerPhone, deps.blindIndexKey);
      const sellerPhoneEnc = encryptField(sellerPhone, deps.keyRef, 1, {
        shopId: message.shopId,
        table: "outbox_events",
        column: "recipient_phone_enc",
      });
      await enqueueOutboundTx(db, {
        shopId: message.shopId,
        recipientPhoneBidx: sellerBidx,
        recipientPhoneEnc: sellerPhoneEnc,
        keyVersion: 1,
        messageType: "TEXT",
        payload: {
          to: sellerPhone,
          text: "I can only process text messages right now. Please resend this as text.",
        },
      });
    },
  );
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
      await handleUnsupported(message, deps);
      return;
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

async function notifySellerOfMissingDraft(message: InboxMessage, deps: InboundDeps): Promise<void> {
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
        text: "I could not find that entry, please send it again.",
      },
    });
  } catch {
    // The alert row is the durable record; a failed notification must not hide the DEAD state.
  }
}

async function notifySellerOfConsent(message: InboxMessage, deps: InboundDeps): Promise<void> {
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
        text: "Please re-accept the updated privacy terms to continue. Reply YES to consent.",
      },
    });
  } catch {
    // best effort
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

  // Consent gate: first thing. A shop whose consent version is not privacy-v2 must
  // re-consent before any entry processing.
  const version = await getLatestConsentVersion(message.shopId);
  // Only block when a consent record exists with an outdated version. A shop with no
  // consent record yet is handled by onboarding, not by this gate.
  if (version !== null && needsReconsent(version)) {
    const declinedRecent = await consentDeclinedRecently(message.shopId);
    if (!declinedRecent) {
      const already = await reconsentAlreadySentToday(message.shopId);
      if (!already) await notifySellerOfConsent(message, deps);
    }
  }

  try {
    await handleMessage(message, deps);
    await markDone(claimed.id);
    // A summary queued while the 24-hour window was closed is stale by the time the
    // seller messages again. Retire it, then queue a fresh summary for the current
    // pending drafts so the seller never receives yesterday's numbers.
    if (deps.messaging) {
      try {
        const superseded = await supersedeQueuedSummaries(message.shopId, message.receivedAt);
        if (superseded > 0 && !(await hasQueuedSummarySince(message.shopId, message.receivedAt))) {
          const phone = senderPhone(message.body);
          if (phone) {
            const bidx = phoneBlindIndex(phone, deps.blindIndexKey);
            await withTenant(
              { shopId: message.shopId, actorType: "SYSTEM", actorId: "inbound" },
              async (db) => {
                await queueSummaryTx(db, message.shopId, { phone, bidx }, deps.keyRef);
              },
            );
          }
        }
      } catch {
        // A failed refresh leaves the old row queued; the scheduler retries later.
      }
      // Pending digest: surface stale queued messages to the seller.
      try {
        const sellerPhone = senderPhone(message.body);
        if (sellerPhone) {
          const staleRows = await withTenant({ shopId: message.shopId, actorType: "SYSTEM", actorId: "inbound" }, async (db) => {
            return db.query<{ payload: Record<string, unknown> }>(
              sql`SELECT payload FROM app.outbox_events
                   WHERE shop_id = ${message.shopId}
                     AND state = 'QUEUED'
                     AND queued_at < now() - interval '24 hours'`,
            );
          });
          if (staleRows.length > 0) {
            const items = staleRows.map((r) => {
              const p = r.payload as { body?: string; text?: string };
              return (p.body ?? p.text ?? "message").slice(0, 60);
            });
            await deps.messaging.sendText({ to: sellerPhone, text: `Pending while you were away: ${items.join("; ")}` });
            await raiseOutboxStale(message.shopId, claimed.id);
          }
        }
      } catch { /* best effort */ }
      // Release path for the 24-hour window: flush any queued outbound messages now
      // that the seller has sent a user-initiated message (opens the window).
      try {
        await flushQueuedOutboundForShop(message.shopId, { messaging: deps.messaging, keyRef: deps.keyRef });
      } catch {
        // Flushing is best-effort; the scheduler retries queued messages.
      }
    }
    return { processed: true, outcome: "DONE", messageId: claimed.id };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const outcome = await markFailed(claimed.id, reason);
    if (outcome === "DEAD") {
      await raiseInboxDeadLetter(shopId, claimed.id, reason);
      if (reason.startsWith("DRAFT_NOT_FOUND")) {
        await notifySellerOfMissingDraft(message, deps);
      } else {
        await notifySellerOfDeadLetter(message, deps);
      }
    }
    return { processed: true, outcome, messageId: claimed.id, error: reason };
  }
}
