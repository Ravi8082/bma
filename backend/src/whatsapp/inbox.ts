/**
 * Inbox claim service: lease-based message claiming with per-seller ordering.
 *
 * Uses FOR UPDATE SKIP LOCKED for claiming and pg_try_advisory_xact_lock
 * (transaction-level, 64-bit key) for per-seller serialization.
 */

import { withTransaction } from "../config/db";

export interface ClaimedMessage {
  id: string;
  shopId: string;
}

const MAX_ATTEMPTS = 3;

/**
 * Claim the next inbox message for a specific shop.
 * Uses the SECURITY DEFINER function to get the message ID (cross-tenant safe),
 * then acquires a transaction-level advisory lock for per-seller ordering.
 */
export async function claimNextForShop(shopId: string): Promise<ClaimedMessage | null> {
  return withTransaction(async (client) => {
    // Advisory lock key: hash of shop_id (transaction-level, released on commit)
    const lockKey = BigInt("0x" + shopId.replace(/-/g, "").slice(0, 16));
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS acquired",
      [lockKey.toString()],
    );
    if (!lockResult.rows[0]?.acquired) {
      return null; // Another worker holds the lock for this seller
    }

    // Claim via SECURITY DEFINER (returns only id + shop_id)
    const claim = await client.query<{ message_id: string; shop_id: string }>(
      "SELECT message_id, shop_id FROM app.claim_next_inbox_message($1)",
      [shopId],
    );
    if (claim.rows.length === 0) return null;

    const row = claim.rows[0];
    if (!row) return null;

    // Set lease
    await client.query(
      `UPDATE app.inbox_messages SET status = 'PROCESSING', lease_until = now() + interval '30 seconds', attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1`,
      [row.message_id],
    );

    return { id: row.message_id, shopId: row.shop_id };
  });
}

/**
 * Global sweeper: claim the next available inbox message across all shops.
 * Used when no shop-specific worker is available.
 */
export async function claimNextGlobal(): Promise<ClaimedMessage | null> {
  return withTransaction(async (client) => {
    const claim = await client.query<{ message_id: string; shop_id: string }>(
      "SELECT message_id, shop_id FROM app.claim_next_inbox_message_global()",
    );
    if (claim.rows.length === 0) return null;

    const row = claim.rows[0];
    if (!row) return null;

    // Per-seller advisory lock
    const lockKey = BigInt("0x" + row.shop_id.replace(/-/g, "").slice(0, 16));
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS acquired",
      [lockKey.toString()],
    );
    if (!lockResult.rows[0]?.acquired) {
      return null; // Another worker holds the lock for this seller
    }

    await client.query(
      `UPDATE app.inbox_messages SET status = 'PROCESSING', lease_until = now() + interval '30 seconds', attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1`,
      [row.message_id],
    );

    return { id: row.message_id, shopId: row.shop_id };
  });
}

/**
 * Mark a message as DONE.
 */
export async function markDone(messageId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE app.inbox_messages SET status = 'DONE', processed_at = now(), lease_until = NULL, updated_at = now() WHERE id = $1`,
      [messageId],
    );
  });
}

/**
 * Mark a message as FAILED. If attempts >= MAX_ATTEMPTS, mark as DEAD.
 */
export async function markFailed(messageId: string, error: string): Promise<"FAILED" | "DEAD"> {
  return withTransaction(async (client) => {
    const result = await client.query<{ attempt_count: number }>(
      `UPDATE app.inbox_messages SET status = CASE WHEN attempt_count >= $2 THEN 'DEAD' ELSE 'FAILED' END, last_error = $3, lease_until = NULL, updated_at = now() WHERE id = $1 RETURNING attempt_count`,
      [messageId, MAX_ATTEMPTS, error],
    );
    const attempts = result.rows[0]?.attempt_count ?? 0;
    return attempts >= MAX_ATTEMPTS ? "DEAD" : "FAILED";
  });
}

/**
 * Reclaim expired leases (sweeper).
 */
export async function reclaimExpiredLeases(): Promise<number> {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE app.inbox_messages SET status = 'RECEIVED', lease_until = NULL, updated_at = now() WHERE status = 'PROCESSING' AND lease_until < now()`,
    );
    return result.rowCount ?? 0;
  });
}
