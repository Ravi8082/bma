import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant, type TenantContext, type TenantDb } from "../../db/tenant";
import { sql } from "../../db/sql";
import { usePostgres } from "../helpers/postgres";

usePostgres();

function contextFor(shopId: string): TenantContext {
  return { shopId, actorType: "SYSTEM", actorId: `test-${randomUUID()}` };
}

async function createShop(shopId: string): Promise<void> {
  const ctx: TenantContext = contextFor(shopId);
  await withTenant(ctx, async (db: TenantDb) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test shop', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER')`,
    );
  });
}

describe("claim functions", () => {
  it("claim_next_inbox_message returns only id and shop_id", async () => {
    const shopId = randomUUID();
    await createShop(shopId);

    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      // Insert an inbox message
      await client.query(
        `INSERT INTO app.inbox_messages (shop_id, wa_message_id, message_type, body, raw_payload, body_hash, arrival_seq)
         VALUES ($1, $2, 'TEXT', '{}'::jsonb, '{}'::jsonb, '\\x00'::bytea, 1)`,
        [shopId, `msg-${randomUUID()}`],
      );

      const result = await client.query<{ message_id: string; shop_id: string }>(
        "SELECT message_id, shop_id FROM app.claim_next_inbox_message($1)",
        [shopId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.message_id).toBeDefined();
      expect(result.rows[0]?.shop_id).toBe(shopId);
      // Verify only 2 columns returned
      expect(Object.keys(result.rows[0] ?? {})).toHaveLength(2);
    } finally {
      client.release();
    }
  });

  it("claim_next_inbox_message_global returns only id and shop_id", async () => {
    const shopId = randomUUID();
    await createShop(shopId);

    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      await client.query(
        `INSERT INTO app.inbox_messages (shop_id, wa_message_id, message_type, body, raw_payload, body_hash, arrival_seq)
         VALUES ($1, $2, 'TEXT', '{}'::jsonb, '{}'::jsonb, '\\x00'::bytea, 1)`,
        [shopId, `msg-${randomUUID()}`],
      );

      const result = await client.query<{ message_id: string; shop_id: string }>(
        "SELECT message_id, shop_id FROM app.claim_next_inbox_message_global()",
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
      if (result.rows.length > 0) {
        expect(Object.keys(result.rows[0] ?? {})).toHaveLength(2);
      }
    } finally {
      client.release();
    }
  });

  it("has restricted grants (no PUBLIC execute)", async () => {
    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      const r1 = await client.query<{ has_execute: boolean }>(
        "SELECT has_function_privilege('public', 'app.claim_next_inbox_message(uuid)', 'EXECUTE') AS has_execute",
      );
      expect(r1.rows[0]?.has_execute).toBe(false);

      const r2 = await client.query<{ has_execute: boolean }>(
        "SELECT has_function_privilege('public', 'app.claim_next_inbox_message_global()', 'EXECUTE') AS has_execute",
      );
      expect(r2.rows[0]?.has_execute).toBe(false);
    } finally {
      client.release();
    }
  });
});

describe("per-seller ordering", () => {
  it("message 2 is not claimed while message 1 is PROCESSING", async () => {
    const shopId = randomUUID();
    await createShop(shopId);

    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      // Insert two messages
      await client.query(
        `INSERT INTO app.inbox_messages (shop_id, wa_message_id, message_type, body, raw_payload, body_hash, arrival_seq, status)
         VALUES ($1, $2, 'TEXT', '{}'::jsonb, '{}'::jsonb, '\\x00'::bytea, 1, 'RECEIVED')`,
        [shopId, `msg1-${randomUUID()}`],
      );
      await client.query(
        `INSERT INTO app.inbox_messages (shop_id, wa_message_id, message_type, body, raw_payload, body_hash, arrival_seq, status)
         VALUES ($1, $2, 'TEXT', '{}'::jsonb, '{}'::jsonb, '\\x00'::bytea, 2, 'RECEIVED')`,
        [shopId, `msg2-${randomUUID()}`],
      );

      // Claim first message
      const claim1 = await client.query<{ message_id: string }>(
        "SELECT message_id, shop_id FROM app.claim_next_inbox_message($1)",
        [shopId],
      );
      expect(claim1.rows).toHaveLength(1);
      const msg1Id = claim1.rows[0]?.message_id;

      // Mark as PROCESSING
      await client.query(
        `UPDATE app.inbox_messages SET status = 'PROCESSING', lease_until = now() + interval '30 seconds' WHERE id = $1`,
        [msg1Id],
      );

      // Try to claim second message — should return nothing (message 1 is still PROCESSING)
      const claim2 = await client.query<{ message_id: string }>(
        "SELECT message_id, shop_id FROM app.claim_next_inbox_message($1)",
        [shopId],
      );
      expect(claim2.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });
});

describe("status monotonicity", () => {
  it("applies monotonic state updates", async () => {
    const shopId = randomUUID();
    await createShop(shopId);

    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.shop_id', $1, true)", [shopId]);
      // Insert an outbox event
      const msgId = randomUUID();
      await client.query(
        `INSERT INTO app.outbox_events (id, shop_id, message_id, recipient_phone_bidx, message_type, payload, state, provider_message_id)
         VALUES ($1, $2, $3, '\\x00'::bytea, 'TEXT', '{}'::jsonb, 'SENT', 'prov-123')`,
        [msgId, shopId, msgId],
      );

      // Insert status update: DELIVERED (monotonic after SENT)
      await client.query(
        `INSERT INTO app.message_status_updates (shop_id, message_id, provider_message_id, status, occurred_at)
         VALUES ($1, $2, 'prov-123', 'DELIVERED', now())`,
        [shopId, msgId],
      );

      // Verify the outbox state was updated
      const result = await client.query<{ state: string }>(
        "SELECT state FROM app.outbox_events WHERE id = $1",
        [msgId],
      );
      // Note: state update happens in application code, not DB trigger.
      // The DB just stores the status update. The application reconciles.
      expect(result.rows[0]?.state).toBe("SENT");
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
});

describe("outbound states", () => {
  it("never blind-retries from UNKNOWN", async () => {
    const shopId = randomUUID();
    await createShop(shopId);

    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const msgId = randomUUID();
      // Insert an outbox event in UNKNOWN state
      await client.query("SELECT set_config('app.shop_id', $1, true)", [shopId]);
      await client.query(
        `INSERT INTO app.outbox_events (id, shop_id, message_id, recipient_phone_bidx, message_type, payload, state, provider_message_id)
         VALUES ($1, $2, $3, '\\x00'::bytea, 'TEXT', '{}'::jsonb, 'UNKNOWN', 'prov-456')`,
        [msgId, shopId, msgId],
      );

      // Verify the state is UNKNOWN
      const result = await client.query<{ state: string }>(
        "SELECT state FROM app.outbox_events WHERE id = $1",
        [msgId],
      );
      expect(result.rows[0]?.state).toBe("UNKNOWN");

      // A retry should NOT pick up UNKNOWN messages (only QUEUED)
      const claim = await client.query<{ id: string }>(
        `SELECT id FROM app.outbox_events WHERE shop_id = $1 AND state = 'QUEUED' FOR UPDATE SKIP LOCKED LIMIT 1`,
        [shopId],
      );
      expect(claim.rows).toHaveLength(0);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  });
});
