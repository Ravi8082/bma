/**
 * Status webhook handler: monotonic state updates for outbound messages.
 */

import { withTenant, type TenantDb } from "../db/tenant";
import { sql } from "../db/sql";

export async function handleStatusWebhook(
  shopId: string,
  providerMessageId: string,
  status: "SENT" | "DELIVERED" | "READ" | "FAILED",
  occurredAt: Date,
): Promise<void> {
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "status-webhook" }, async (db: TenantDb) => {
    // Insert status update (idempotent via unique constraint)
    try {
      await db.execute(
        sql`INSERT INTO app.message_status_updates (shop_id, message_id, provider_message_id, status, occurred_at)
             VALUES (${shopId}, (SELECT message_id FROM app.outbox_events WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId} LIMIT 1), ${providerMessageId}, ${status}, ${occurredAt})`,
      );
    } catch {
      // Duplicate status update — ignore
      return;
    }

    // Apply monotonic state update
    const rows = await db.query<{ state: string }>(
      sql`SELECT state FROM app.outbox_events WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
    if (rows.length === 0) return;

    const current = rows[0]?.state ?? "";
    const order: Record<string, number> = {
      QUEUED: 0, SENDING: 1, SENT: 2, UNKNOWN: 3, DELIVERED: 4, READ: 5, FAILED: 6, DEAD: 7,
    };
    if ((order[status] ?? 0) <= (order[current] ?? 0)) return; // not monotonic

    await db.execute(
      sql`UPDATE app.outbox_events SET state = ${status}, updated_at = now() WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
  });
}
