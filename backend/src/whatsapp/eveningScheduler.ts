/**
 * Evening scheduler.
 *
 * Once per shop per local day, at the shop's configured evening time, snapshot the shop's
 * pending drafts into a batch and queue the evening summary. The summary is a normal
 * outbox row, so the 24-hour window rule (approved template when the window is closed,
 * otherwise stay queued) is applied by the outbound sender, not here.
 *
 * Idempotency is the primary key on `app.evening_runs (shop_id, run_date)`, claimed in the
 * same transaction as the batch and the outbox row. Two instances may tick at once and a
 * process may restart mid-evening, but at most one summary is queued per shop and day.
 */

import { randomUUID } from "node:crypto";
import { decryptField, encryptField } from "../crypto/fieldEncryption";
import { queryWithoutTenant, withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";
import { formatPaise } from "./confirmation";
import { enqueueOutboundTx } from "./outbound";

export interface EveningDeps {
  keyRef: string;
}

export interface EveningTickResult {
  /** Shops whose local clock is at or past their configured evening time. */
  dueShops: number;
  /** Shops where a summary was queued by this tick. */
  ranShops: number;
  /** Shops with no pending drafts; the day is recorded and nothing is sent. */
  emptyShops: number;
  /** Shops already recorded for their local date (another instance, or a restart). */
  skippedShops: number;
  /** Shops that have no active owner to address. */
  noOwnerShops: number;
}

const DAY_MINUTES = 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export interface LocalTime {
  /** Local calendar date as YYYY-MM-DD. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
}

/** The shop's calendar date and minute-of-day at the supplied instant. */
export function localTimeParts(now: Date, timeZone: string): LocalTime {
  const parts = formatterFor(timeZone).formatToParts(now);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number.parseInt(value("hour"), 10);
  const minute = Number.parseInt(value("minute"), 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`cannot read local time for ${timeZone}`);
  }
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    minutes: hour * 60 + minute,
  };
}

/** `HH:MM` to minutes since midnight, or null when the value is not a valid time. */
export function parseEveningTime(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10) * 60 + Number.parseInt(match[2]!, 10);
}

/**
 * True from the configured evening time until local midnight.
 *
 * The lower bound makes a restart later in the evening catch up instead of losing the day;
 * the upper bound stops yesterday's summary from firing after local midnight.
 */
export function isEveningDue(now: Date, timeZone: string, eveningTime: string): boolean {
  const configured = parseEveningTime(eveningTime);
  if (configured === null) return false;
  const local = localTimeParts(now, timeZone);
  return local.minutes >= configured && local.minutes < DAY_MINUTES;
}

export interface SummaryRecipient {
  phone: string;
  bidx: Buffer;
}

export interface QueuedSummary {
  queued: boolean;
  entries: number;
  totalPaise: number;
  batchId: string | null;
}

function summaryText(entries: number, totalPaise: number): string {
  return `Evening summary: ${entries} ${entries === 1 ? "entry" : "entries"}, total ${formatPaise(totalPaise)}.`;
}

/**
 * Snapshot the shop's pending drafts into a fresh batch and queue one summary.
 *
 * Runs inside the caller's transaction so the batch, the outbox row and the caller's
 * idempotency row commit or roll back together. No ledger row is written here: only an
 * explicit seller confirmation posts money.
 */
export async function queueSummaryTx(
  db: TenantDb,
  shopId: string,
  recipient: SummaryRecipient,
  keyRef: string,
): Promise<QueuedSummary> {
  const pending = await db.query<{ id: string; amount_paise: string }>(
    sql`SELECT id, amount_paise FROM app.entry_drafts
         WHERE shop_id = ${shopId} AND status = 'PENDING'
         ORDER BY created_at, entry_index`,
  );
  if (pending.length === 0) {
    return { queued: false, entries: 0, totalPaise: 0, batchId: null };
  }

  const batchId = randomUUID();
  await db.execute(
    sql`UPDATE app.entry_drafts SET batch_id = ${batchId}
         WHERE shop_id = ${shopId} AND status = 'PENDING'`,
  );

  let totalPaise = 0;
  for (const draft of pending) totalPaise += Number.parseInt(draft.amount_paise, 10);

  await enqueueOutboundTx(db, {
    shopId,
    recipientPhoneBidx: recipient.bidx,
    recipientPhoneEnc: encryptField(recipient.phone, keyRef, 1, {
      shopId,
      table: "outbox_events",
      column: "recipient_phone_enc",
    }),
    keyVersion: 1,
    messageType: "TEXT",
    payload: { to: recipient.phone, text: summaryText(pending.length, totalPaise) },
  });

  return { queued: true, entries: pending.length, totalPaise, batchId };
}

class NoOwnerError extends Error {
  constructor() {
    super("shop has no active owner to send the evening summary to");
    this.name = "NoOwnerError";
  }
}

export type EveningRunOutcome = "ran" | "empty" | "already" | "no_owner";

/** Claim one shop's local date and queue its summary. Safe to call concurrently. */
export async function runEveningForShop(
  shopId: string,
  localDate: string,
  deps: EveningDeps,
): Promise<EveningRunOutcome> {
  try {
    return await withTenant(
      { shopId, actorType: "SYSTEM", actorId: "evening-scheduler" },
      async (db) => {
        // The unique key is the idempotency guarantee. A concurrent instance waits on the
        // index and then sees no returned row, so it performs no side effects.
        const claimed = await db.query<{ shop_id: string }>(
          sql`INSERT INTO app.evening_runs (shop_id, run_date)
              VALUES (${shopId}, ${localDate}::date)
              ON CONFLICT (shop_id, run_date) DO NOTHING
              RETURNING shop_id`,
        );
        if (claimed.length === 0) return "already";

        const owner = await db.queryOne<{ phone_enc: Buffer; phone_bidx: Buffer }>(
          sql`SELECT phone_enc, phone_bidx FROM app.users
               WHERE shop_id = ${shopId} AND role = 'OWNER' AND status = 'ACTIVE'
               ORDER BY created_at
               LIMIT 1`,
        );
        if (!owner) throw new NoOwnerError();

        const phone = decryptField(owner.phone_enc, deps.keyRef, {
          shopId,
          table: "users",
          column: "phone_enc",
        });
        const summary = await queueSummaryTx(db, shopId, { phone, bidx: owner.phone_bidx }, deps.keyRef);

        if (summary.batchId) {
          await db.execute(
            sql`UPDATE app.evening_runs SET batch_id = ${summary.batchId}
                 WHERE shop_id = ${shopId} AND run_date = ${localDate}::date`,
          );
        }
        return summary.queued ? "ran" : "empty";
      },
    );
  } catch (error) {
    if (error instanceof NoOwnerError) return "no_owner";
    throw error;
  }
}

/**
 * Tick every shop whose local clock has reached its configured evening time.
 *
 * `shopIds` narrows the candidate list (used by tests and by an operator backfill); the
 * default is every shop known to the platform queue. Settings are always read per shop
 * under tenant context, so this never reads another shop's rows.
 */
export async function runEveningTick(
  deps: EveningDeps,
  now: Date = new Date(),
  shopIds?: string[],
): Promise<EveningTickResult> {
  const result: EveningTickResult = {
    dueShops: 0,
    ranShops: 0,
    emptyShops: 0,
    skippedShops: 0,
    noOwnerShops: 0,
  };

  const candidates =
    shopIds ??
    (
      await queryWithoutTenant<{ shop_id: string }>(
        sql`SELECT DISTINCT shop_id FROM app.inbox_messages`,
      )
    ).map((row) => row.shop_id);

  for (const shopId of candidates) {
    const settings = await withTenant(
      { shopId, actorType: "SYSTEM", actorId: "evening-scheduler" },
      async (db) =>
        db.queryOne<{ timezone: string; evening_summary_time: string }>(
          sql`SELECT timezone, evening_summary_time FROM app.shop_settings WHERE shop_id = ${shopId}`,
        ),
    );
    if (!settings) continue;
    if (!isEveningDue(now, settings.timezone, settings.evening_summary_time)) continue;

    result.dueShops += 1;
    const localDate = localTimeParts(now, settings.timezone).date;
    const outcome = await runEveningForShop(shopId, localDate, deps);
    if (outcome === "ran") result.ranShops += 1;
    else if (outcome === "empty") result.emptyShops += 1;
    else if (outcome === "already") result.skippedShops += 1;
    else result.noOwnerShops += 1;
  }

  return result;
}
