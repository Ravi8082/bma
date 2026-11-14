/**
 * Inbox claim service: lease-based message claiming with per-seller ordering.
 *
 * `inbox_messages` is a platform-level queue (no RLS), like `security_events`. It carries no
 * financial data. Claims go through SECURITY DEFINER functions that return only id + shop_id.
 * The lease is written in the same short transaction as the claim; processing happens after
 * that transaction commits, so no connection is held during parsing or network calls.
 */

import { withTransaction } from "../config/db";
import { queryWithoutTenant } from "../db/tenant";
import { sql } from "../db/sql";

export interface ClaimedMessage {
  id: string;
  shopId: string;
}

export interface InboxMessage {
  id: string;
  shopId: string;
  waMessageId: string;
  messageType: string;
  body: Record<string, unknown>;
  status: string;
  attemptCount: number;
  lastError: string | null;
}

interface InboxRow {
  id: string;
  shop_id: string;
  wa_message_id: string;
  message_type: string;
  body: Record<string, unknown>;
  status: string;
  attempt_count: number;
  last_error: string | null;
}

const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 30;
const RETRY_BACKOFF_SECONDS = 2;

function advisoryKey(shopId: string): string {
  // 64-bit signed key derived from the UUID. asIntN keeps it inside PostgreSQL bigint.
  return BigInt.asIntN(64, BigInt(`0x${shopId.replace(/-/g, "").slice(0, 16)}`)).toString();
}

/**
 * Claim the oldest unfinished message for one seller.
 * Returns null when another worker already holds the seller's advisory lock or there is no
 * claimable message.
 */
export async function claimNextForShop(shopId: string): Promise<ClaimedMessage | null> {
  return withTransaction(async (client) => {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [advisoryKey(shopId)],
    );
    if (!lock.rows[0]?.acquired) return null;

    const claim = await client.query<{ message_id: string; shop_id: string }>(
      "SELECT message_id, shop_id FROM app.claim_next_inbox_message($1)",
      [shopId],
    );
    const row = claim.rows[0];
    if (!row) return null;

    await client.query(
      `UPDATE app.inbox_messages
          SET status = 'PROCESSING',
              lease_until = now() + make_interval(secs => $2),
              attempt_count = attempt_count + 1,
              updated_at = now()
        WHERE id = $1`,
      [row.message_id, LEASE_SECONDS],
    );

    return { id: row.message_id, shopId: row.shop_id };
  });
}

/** Global sweeper claim, used only when no shop list is available. */
export async function claimNextGlobal(): Promise<ClaimedMessage | null> {
  return withTransaction(async (client) => {
    const claim = await client.query<{ message_id: string; shop_id: string }>(
      "SELECT message_id, shop_id FROM app.claim_next_inbox_message_global()",
    );
    const row = claim.rows[0];
    if (!row) return null;

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [advisoryKey(row.shop_id)],
    );
    if (!lock.rows[0]?.acquired) return null;

    await client.query(
      `UPDATE app.inbox_messages
          SET status = 'PROCESSING',
              lease_until = now() + make_interval(secs => $2),
              attempt_count = attempt_count + 1,
              updated_at = now()
        WHERE id = $1`,
      [row.message_id, LEASE_SECONDS],
    );

    return { id: row.message_id, shopId: row.shop_id };
  });
}

/** Read the persisted raw message after the claim transaction has committed. */
export async function getInboxMessage(messageId: string): Promise<InboxMessage | null> {
  const rows = await queryWithoutTenant<InboxRow>(
    sql`SELECT id, shop_id, wa_message_id, message_type, body, status, attempt_count, last_error
          FROM app.inbox_messages
         WHERE id = ${messageId}`,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    shopId: row.shop_id,
    waMessageId: row.wa_message_id,
    messageType: row.message_type,
    body: row.body,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
  };
}

export async function markDone(messageId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE app.inbox_messages
          SET status = 'DONE', processed_at = now(), lease_until = NULL, updated_at = now()
        WHERE id = $1`,
      [messageId],
    );
  });
}

/**
 * Record a failed attempt. The third failure moves the message to DEAD.
 * Retryable failures get a short backoff stored in lease_until; DEAD never retries.
 */
export async function markFailed(messageId: string, error: string): Promise<"FAILED" | "DEAD"> {
  return withTransaction(async (client) => {
    const result = await client.query<{ status: string }>(
      `UPDATE app.inbox_messages
          SET status = CASE WHEN attempt_count >= $2 THEN 'DEAD' ELSE 'FAILED' END,
              last_error = $3,
              lease_until = CASE
                WHEN attempt_count >= $2 THEN NULL
                ELSE now() + make_interval(secs => $4)
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING status`,
      [messageId, MAX_ATTEMPTS, error, RETRY_BACKOFF_SECONDS],
    );
    const status = result.rows[0]?.status;
    return status === "DEAD" ? "DEAD" : "FAILED";
  });
}

/** Reset expired PROCESSING leases so a crashed worker's message becomes claimable again. */
export async function reclaimExpiredLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE app.inbox_messages
          SET status = 'RECEIVED', lease_until = NULL, updated_at = now()
        WHERE status = 'PROCESSING' AND lease_until IS NOT NULL AND lease_until < now()`,
    );
    return result.rowCount ?? 0;
  });
}

/** Shop identifiers with claimable inbox work. Returns UUIDs only, no message content. */
export async function listShopIdsWithPendingInbox(): Promise<string[]> {
  const rows = await queryWithoutTenant<{ shop_id: string }>(
    sql`SELECT shop_id FROM app.list_shop_ids_with_pending_inbox()`,
  );
  return rows.map((row) => row.shop_id);
}

/** Shop identifiers with due outbound work. Returns UUIDs only. */
export async function listShopIdsWithQueuedOutbox(): Promise<string[]> {
  const rows = await queryWithoutTenant<{ shop_id: string }>(
    sql`SELECT shop_id FROM app.list_shop_ids_with_queued_outbox()`,
  );
  return rows.map((row) => row.shop_id);
}
