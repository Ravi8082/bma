/**
 * Operational alerts for messages that exhausted their retries.
 *
 * `security_events` is platform-level (no shop_id, no RLS) and INSERT-only for the app role.
 * The detail payload carries the shop reference; message content is never copied here.
 */

import { queryWithoutTenant } from "../db/tenant";
import { sql } from "../db/sql";

async function raise(
  eventType: string,
  actorRef: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await queryWithoutTenant(
    sql`INSERT INTO app.security_events (event_type, severity, actor_ref, detail)
        VALUES (${eventType}, 'HIGH', ${actorRef}, ${JSON.stringify(detail)}::jsonb)`,
  );
}

export async function raiseInboxDeadLetter(
  shopId: string,
  messageId: string,
  error: string,
): Promise<void> {
  await raise("INBOX_DEAD_LETTER", messageId, {
    shopId,
    messageId,
    error: error.slice(0, 500),
    attempts: 3,
  });
}

export async function raiseOutboxDeadLetter(
  shopId: string,
  outboxId: string,
  error: string,
): Promise<void> {
  await raise("OUTBOX_DEAD_LETTER", outboxId, {
    shopId,
    outboxId,
    error: error.slice(0, 500),
    attempts: 3,
  });
}
