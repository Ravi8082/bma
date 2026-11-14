/**
 * Status webhook handler: monotonic state updates for outbound messages.
 *
 * Meta delivers statuses out of order and may replay them. Each update is recorded in
 * `message_status_updates` (idempotent on the full tuple). The outbox row is advanced
 * only when the new status strictly ranks above every previously recorded status for
 * that message; out-of-order and duplicate deliveries are recorded but have no effect.
 * Only `FAILED` changes the outbox send state (to FAILED/DEAD with retry scheduling);
 * delivery progress (SENT/DELIVERED/READ) is tracked in `message_status_updates`.
 */
import { withTenant, type TenantDb } from "../db/tenant";
import { queryWithoutTenant } from "../db/tenant";
import { sql } from "../db/sql";

export type StatusKind = "SENT" | "DELIVERED" | "READ" | "FAILED";

const RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  UNKNOWN: 3,
  DELIVERED: 4,
  READ: 5,
  FAILED: 6,
  DEAD: 7,
};

export async function resolveShopByProviderMessageId(
  providerMessageId: string,
): Promise<string | null> {
  const rows = await queryWithoutTenant<{ shop_id: string }>(
    sql`SELECT shop_id FROM app.provider_message_index WHERE provider_message_id = ${providerMessageId}`,
  );
  return rows[0]?.shop_id ?? null;
}

export type StatusApplyResult = "APPLIED" | "IGNORED" | "DUPLICATE" | "UNKNOWN";

export async function handleStatusWebhook(
  shopId: string,
  providerMessageId: string,
  status: StatusKind,
  occurredAt: Date,
  errorMessage?: string,
): Promise<StatusApplyResult> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "status-webhook" }, async (db: TenantDb) => {
    const rows = await db.query<{ id: string; message_id: string }>(
      sql`SELECT id, message_id
            FROM app.outbox_events
           WHERE shop_id = ${shopId} AND provider_message_id = ${providerMessageId}`,
    );
    const outbox = rows[0];
    if (!outbox) return "UNKNOWN";

    // Prior recorded statuses for this message (excluding the incoming tuple).
    const prior = await db.query<{ status: string }>(
      sql`SELECT status FROM app.message_status_updates
           WHERE shop_id = ${shopId} AND message_id = ${outbox.message_id}
             AND NOT (status = ${status} AND occurred_at = ${occurredAt})`,
    );
    const priorMax = prior.reduce((max, row) => Math.max(max, RANK[row.status] ?? 0), 0);

    const inserted = await db.query<{ id: string }>(
      sql`INSERT INTO app.message_status_updates
            (shop_id, message_id, provider_message_id, status, occurred_at)
          VALUES
            (${shopId}, ${outbox.message_id}, ${providerMessageId}, ${status}, ${occurredAt})
          ON CONFLICT (shop_id, message_id, status, occurred_at) DO NOTHING
          RETURNING id`,
    );
    const duplicate = !inserted[0];

    const newRank = RANK[status] ?? 0;
    const applied = !duplicate && newRank > priorMax;
    if (!applied) {
      return duplicate ? "DUPLICATE" : "IGNORED";
    }

    if (status === "FAILED") {
      await db.execute(
        sql`UPDATE app.outbox_events
               SET state = CASE WHEN attempt_count >= 3 THEN 'DEAD' ELSE 'FAILED' END,
                   last_error = ${errorMessage ?? "provider reported FAILED"},
                   failed_at = now(),
                   next_attempt_at = CASE
                     WHEN attempt_count >= 3 THEN NULL
                     ELSE now() + interval '5 seconds'
                   END,
                   updated_at = now()
             WHERE id = ${outbox.id} AND shop_id = ${shopId}`,
      );
    } else if (status === "SENT") {
      await db.execute(
        sql`UPDATE app.outbox_events
               SET state = 'SENT', sent_at = COALESCE(sent_at, now()), updated_at = now()
             WHERE id = ${outbox.id} AND shop_id = ${shopId}
               AND state IN ('QUEUED', 'SENDING', 'UNKNOWN')`,
      );
    }

    await db.execute(
      sql`INSERT INTO app.audit_logs
            (shop_id, actor_type, actor_id, action, entity_type, entity_id, reason)
          VALUES
            (${shopId}, 'SYSTEM', 'status-webhook', 'MESSAGE_STATUS_UPDATE', 'outbox_event',
             ${outbox.id}, ${status})`,
    );

    return "APPLIED";
  });
}
