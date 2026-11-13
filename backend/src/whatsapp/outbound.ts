/**
 * Outbound sender with state tracking.
 *
 * States: QUEUED → SENDING → SENT → (UNKNOWN → reconciled) → FAILED → DEAD
 * Never blind-retry from UNKNOWN.
 */

import { withTransaction } from "../config/db";
import { withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";

export type OutboundState = "QUEUED" | "SENDING" | "SENT" | "UNKNOWN" | "FAILED" | "DEAD";

export interface OutboundMessage {
  id: string;
  shopId: string;
  recipientPhoneBidx: Buffer;
  messageType: string;
  payload: Record<string, unknown>;
  state: OutboundState;
  attemptCount: number;
  lastError: string | null;
  providerMessageId: string | null;
}

const MAX_ATTEMPTS = 3;

export async function enqueueOutbound(
  shopId: string,
  recipientPhoneBidx: Buffer,
  messageType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const id = crypto.randomUUID();
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "outbound" }, async (db: TenantDb) => {
    await db.execute(
      sql`INSERT INTO app.outbox_events (id, shop_id, message_id, recipient_phone_bidx, message_type, payload, state)
           VALUES (${id}, ${shopId}, ${id}, ${recipientPhoneBidx}, ${messageType}, ${JSON.stringify(payload)}::jsonb, 'QUEUED')`,
    );
  });
  return id;
}

export async function claimNextOutbound(shopId: string): Promise<OutboundMessage | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      shop_id: string;
      message_id: string;
      recipient_phone_bidx: Buffer;
      message_type: string;
      payload: Record<string, unknown>;
      state: string;
      attempt_count: number;
      last_error: string | null;
      provider_message_id: string | null;
    }>(
      `UPDATE app.outbox_events SET state = 'SENDING', sending_at = now(), attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = (SELECT id FROM app.outbox_events WHERE shop_id = $1 AND state = 'QUEUED' ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`,
      [shopId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      shopId: row.shop_id,
      recipientPhoneBidx: row.recipient_phone_bidx,
      messageType: row.message_type,
      payload: row.payload,
      state: row.state as OutboundState,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      providerMessageId: row.provider_message_id,
    };
  });
}

export async function markSent(id: string, providerMessageId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE app.outbox_events SET state = 'SENT', sent_at = now(), provider_message_id = $2, updated_at = now() WHERE id = $1`,
      [id, providerMessageId],
    );
  });
}

export async function markUnknown(id: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE app.outbox_events SET state = 'UNKNOWN', updated_at = now() WHERE id = $1 AND state = 'SENDING'`,
      [id],
    );
  });
}

export async function markFailed(id: string, error: string): Promise<OutboundState> {
  return withTransaction(async (client) => {
    const result = await client.query<{ attempt_count: number }>(
      `UPDATE app.outbox_events SET state = CASE WHEN attempt_count >= $2 THEN 'DEAD' ELSE 'FAILED' END, last_error = $3, failed_at = now(), updated_at = now() WHERE id = $1 RETURNING attempt_count`,
      [id, MAX_ATTEMPTS, error],
    );
    const attempts = result.rows[0]?.attempt_count ?? 0;
    return attempts >= MAX_ATTEMPTS ? "DEAD" : "FAILED";
  });
}

export async function reconcileStatus(
  shopId: string,
  providerMessageId: string,
  status: "SENT" | "DELIVERED" | "READ" | "FAILED",
): Promise<void> {
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "status-webhook" }, async (db) => {
    // Monotonic: only apply if the new status is "higher" than current
    const rows = await db.query<{ state: string }>(
      sql`SELECT state FROM app.outbox_events WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
    if (rows.length === 0) return;
    const current = rows[0]?.state;
    const order: Record<string, number> = { QUEUED: 0, SENDING: 1, SENT: 2, UNKNOWN: 3, DELIVERED: 4, READ: 5, FAILED: 6, DEAD: 7 };
    if (current && (order[status] ?? 0) <= (order[current] ?? 0)) return; // not monotonic

    await db.execute(
      sql`UPDATE app.outbox_events SET state = ${status}, updated_at = now() WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
  });
}
