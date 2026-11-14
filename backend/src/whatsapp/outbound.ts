/**
 * Outbound queue with state tracking.
 *
 * States: QUEUED → SENDING → SENT → (UNKNOWN → reconciled) → FAILED → DEAD
 * Never blind-retry from UNKNOWN: only QUEUED and FAILED (after backoff) are claimable.
 *
 * Every statement runs inside `withTenant()` because `outbox_events` is FORCE RLS.
 * The recipient phone is stored encrypted (AAD bound to this table and column).
 */

import { withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";

export type OutboundState = "QUEUED" | "SENDING" | "SENT" | "UNKNOWN" | "FAILED" | "DEAD";

export interface OutboundMessage {
  id: string;
  shopId: string;
  recipientPhoneBidx: Buffer;
  recipientPhoneEnc: Buffer | null;
  keyVersion: number;
  messageType: string;
  payload: Record<string, unknown>;
  state: OutboundState;
  attemptCount: number;
  lastError: string | null;
  providerMessageId: string | null;
}

interface OutboxRow {
  id: string;
  shop_id: string;
  message_id: string;
  recipient_phone_bidx: Buffer;
  recipient_phone_enc: Buffer | null;
  key_version: number;
  message_type: string;
  payload: Record<string, unknown>;
  state: string;
  attempt_count: number;
  last_error: string | null;
  provider_message_id: string | null;
}

const MAX_ATTEMPTS = 3;

function contextFor(shopId: string): { shopId: string; actorType: "WORKER"; actorId: string } {
  return { shopId, actorType: "WORKER", actorId: "outbox" };
}

/**
 * Insert one outbound message using the caller's open transaction.
 *
 * Callers that change business state (draft confirmation, dead-letter notice) must use this
 * form so the outbox row commits or rolls back with that state.
 */
export async function enqueueOutboundTx(
  db: TenantDb,
  input: {
    shopId: string;
    recipientPhoneBidx: Buffer;
    recipientPhoneEnc: Buffer;
    keyVersion: number;
    messageType: "TEXT" | "TEMPLATE" | "DOCUMENT" | "IMAGE" | "AUDIO";
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(
    sql`INSERT INTO app.outbox_events
          (id, shop_id, message_id, recipient_phone_bidx, recipient_phone_enc, key_version,
           message_type, payload, state)
        VALUES
          (${id}, ${input.shopId}, ${id}, ${input.recipientPhoneBidx}, ${input.recipientPhoneEnc},
           ${input.keyVersion}, ${input.messageType}, ${JSON.stringify(input.payload)}::jsonb, 'QUEUED')`,
  );
  return id;
}

/** Standalone enqueue: opens its own tenant transaction. */
export async function enqueueOutbound(input: {
  shopId: string;
  recipientPhoneBidx: Buffer;
  recipientPhoneEnc: Buffer;
  keyVersion: number;
  messageType: "TEXT" | "TEMPLATE" | "DOCUMENT" | "IMAGE" | "AUDIO";
  payload: Record<string, unknown>;
}): Promise<string> {
  return withTenant(contextFor(input.shopId), async (db) => enqueueOutboundTx(db, input));
}

/** Claim the oldest due outbound message for one shop, with a SKIP LOCKED row lock. */
export async function claimNextOutbound(shopId: string): Promise<OutboundMessage | null> {
  return withTenant(contextFor(shopId), async (db) => {
    const rows = await db.query<OutboxRow>(
      sql`SELECT id, shop_id, message_id, recipient_phone_bidx, recipient_phone_enc, key_version,
                 message_type, payload, state, attempt_count, last_error, provider_message_id
            FROM app.outbox_events
           WHERE shop_id = ${shopId}
             AND state IN ('QUEUED', 'FAILED')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY queued_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;

    await db.execute(
      sql`UPDATE app.outbox_events
             SET state = 'SENDING', sending_at = now(), attempt_count = attempt_count + 1,
                 updated_at = now()
           WHERE id = ${row.id} AND shop_id = ${shopId}`,
    );

    return {
      id: row.id,
      shopId: row.shop_id,
      recipientPhoneBidx: row.recipient_phone_bidx,
      recipientPhoneEnc: row.recipient_phone_enc,
      keyVersion: row.key_version,
      messageType: row.message_type,
      payload: row.payload,
      state: "SENDING",
      attemptCount: row.attempt_count + 1,
      lastError: row.last_error,
      providerMessageId: row.provider_message_id,
    };
  });
}

export async function markSent(
  shopId: string,
  id: string,
  providerMessageId: string,
): Promise<void> {
  await withTenant(contextFor(shopId), async (db) => {
    await db.execute(
      sql`UPDATE app.outbox_events
             SET state = 'SENT', sent_at = now(), provider_message_id = ${providerMessageId},
                 next_attempt_at = NULL, updated_at = now()
           WHERE id = ${id} AND shop_id = ${shopId}`,
    );
    await db.execute(
      sql`INSERT INTO app.provider_message_index (provider_message_id, shop_id, outbox_id)
          VALUES (${providerMessageId}, ${shopId}, ${id})
          ON CONFLICT (provider_message_id) DO NOTHING`,
    );
  });
}

/**
 * The provider accepted the request but the outcome is unknown (timeout, connection reset).
 * The message is never re-sent automatically; a status webhook or a human reconciles it.
 */
export async function markUnknown(shopId: string, id: string): Promise<void> {
  await withTenant(contextFor(shopId), async (db) => {
    await db.execute(
      sql`UPDATE app.outbox_events
             SET state = 'UNKNOWN', next_attempt_at = NULL, updated_at = now()
           WHERE id = ${id} AND shop_id = ${shopId} AND state = 'SENDING'`,
    );
  });
}

export async function markFailed(
  shopId: string,
  id: string,
  error: string,
): Promise<OutboundState> {
  return withTenant(contextFor(shopId), async (db) => {
    const rows = await db.query<{ state: string }>(
      sql`UPDATE app.outbox_events
             SET state = CASE WHEN attempt_count >= ${MAX_ATTEMPTS} THEN 'DEAD' ELSE 'FAILED' END,
                 last_error = ${error},
                 failed_at = now(),
                 next_attempt_at = CASE
                   WHEN attempt_count >= ${MAX_ATTEMPTS} THEN NULL
                   ELSE now() + interval '5 seconds'
                 END,
                 updated_at = now()
           WHERE id = ${id} AND shop_id = ${shopId}
           RETURNING state`,
    );
    return (rows[0]?.state ?? "FAILED") as OutboundState;
  });
}

export async function reconcileStatus(
  shopId: string,
  providerMessageId: string,
  status: "SENT" | "DELIVERED" | "READ" | "FAILED",
): Promise<void> {
  await withTenant(contextFor(shopId), async (db) => {
    const rows = await db.query<{ state: string }>(
      sql`SELECT state FROM app.outbox_events
           WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
    if (rows.length === 0) return;
    const current = rows[0]?.state;
    const order: Record<string, number> = {
      QUEUED: 0, SENDING: 1, SENT: 2, UNKNOWN: 3, DELIVERED: 4, READ: 5, FAILED: 6, DEAD: 7,
    };
    if (current && (order[status] ?? 0) <= (order[current] ?? 0)) return;

    await db.execute(
      sql`UPDATE app.outbox_events SET state = ${status}, updated_at = now()
           WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
  });
}
