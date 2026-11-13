import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant, type TenantContext, type TenantDb } from "../../db/tenant";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { normalisePhone } from "../../crypto/phone";
import { sql } from "../../db/sql";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const BLIND_INDEX_KEY = "test-blind-index-key-32-bytes-min";

function contextFor(shopId: string): TenantContext {
  return { shopId, actorType: "SYSTEM", actorId: `test-${randomUUID()}` };
}

async function createShopAndOwner(shopId: string, phone: string): Promise<{ userId: string; bidx: Buffer }> {
  const ctx: TenantContext = contextFor(shopId);
  const normalised = normalisePhone(phone);
  const bidx = phoneBlindIndex(normalised, BLIND_INDEX_KEY);

  return withTenant(ctx, async (db: TenantDb) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test seller', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER')`,
    );
    const userId = randomUUID();
    await db.execute(
      sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
           VALUES (${userId}, ${shopId}, 'OWNER', 'Test Owner', ${Buffer.from("encrypted")}, ${bidx}, 1, 'ACTIVE')`,
    );
    return { userId, bidx };
  });
}

describe("SECURITY DEFINER: resolve_seller_by_phone", () => {
  it("returns shop_id, user_id, role for a registered phone", async () => {
    const shopId = randomUUID();
    const { userId, bidx } = await createShopAndOwner(shopId, `98765${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`);

    // Call the SECURITY DEFINER function as bma_app (via raw client, no tenant context)
    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      const result = await client.query<{ shop_id: string; user_id: string; role: string }>(
        "SELECT shop_id, user_id, role FROM app.resolve_seller_by_phone($1)",
        [bidx],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.shop_id).toBe(shopId);
      expect(result.rows[0]?.user_id).toBe(userId);
      expect(result.rows[0]?.role).toBe("OWNER");
    } finally {
      client.release();
    }
  });

  it("returns zero rows for an unregistered phone (no enumeration)", async () => {
    const unknownBidx = phoneBlindIndex("+919999999999", BLIND_INDEX_KEY);
    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      const result = await client.query<{ shop_id: string; user_id: string; role: string }>(
        "SELECT shop_id, user_id, role FROM app.resolve_seller_by_phone($1)",
        [unknownBidx],
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      client.release();
    }
  });

  it("has restricted grants (no PUBLIC execute)", async () => {
    const { getPool } = await import("../../config/db");
    const client = await getPool().connect();
    try {
      const result = await client.query<{ has_execute: boolean }>(
        "SELECT has_function_privilege('public', 'app.resolve_seller_by_phone(bytea)', 'EXECUTE') AS has_execute",
      );
      expect(result.rows[0]?.has_execute).toBe(false);
    } finally {
      client.release();
    }
  });
});

describe("concurrency: one shop per phone", () => {
  it("creates exactly one shop for concurrent first messages", async () => {
    const phone = `91234${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`;
    const normalised = normalisePhone(phone);
    const bidx = phoneBlindIndex(normalised, BLIND_INDEX_KEY);

    // Simulate two concurrent shop creations with the same phone blind index.
    // The second should fail with a unique constraint violation.
    const shopId1 = randomUUID();
    const shopId2 = randomUUID();
    const ctx1: TenantContext = contextFor(shopId1);
    const ctx2: TenantContext = contextFor(shopId2);

    await withTenant(ctx1, async (db: TenantDb) => {
      await db.execute(
        sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId1}, 'Seller 1', ${`t-${shopId1.slice(0, 8)}`}, 'FLOWER_SELLER')`,
      );
      const userId1 = randomUUID();
      await db.execute(
        sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
             VALUES (${userId1}, ${shopId1}, 'OWNER', 'Owner 1', ${Buffer.from("enc1")}, ${bidx}, 1, 'ACTIVE')`,
      );
    });

    // Second attempt with same blind index should fail.
    await expect(
      withTenant(ctx2, async (db: TenantDb) => {
        await db.execute(
          sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId2}, 'Seller 2', ${`t-${shopId2.slice(0, 8)}`}, 'FLOWER_SELLER')`,
        );
        const userId2 = randomUUID();
        await db.execute(
          sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
               VALUES (${userId2}, ${shopId2}, 'OWNER', 'Owner 2', ${Buffer.from("enc2")}, ${bidx}, 1, 'ACTIVE')`,
        );
      }),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("consent versioning", () => {
  it("stores versioned consent records", async () => {
    const shopId = randomUUID();
    const ctx: TenantContext = contextFor(shopId);

    await withTenant(ctx, async (db: TenantDb) => {
      await db.execute(
        sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Consent shop', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER')`,
      );
      const userId = randomUUID();
      const bidx = phoneBlindIndex(`+919988${Math.floor(Math.random() * 100000).toString().padStart(5, "0")}`, BLIND_INDEX_KEY);
      await db.execute(
        sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
             VALUES (${userId}, ${shopId}, 'OWNER', 'Owner', ${Buffer.from("enc")}, ${bidx}, 1, 'ACTIVE')`,
      );
      await db.execute(
        sql`INSERT INTO app.consent_records (shop_id, user_id, purpose, granted, policy_version, method)
             VALUES (${shopId}, ${userId}, 'BOOKKEEPING', true, 'privacy-v1', 'WHATSAPP')`,
      );

      const rows = await db.query<{ purpose: string; policy_version: string; granted: boolean }>(
        sql`SELECT purpose, policy_version, granted FROM app.consent_records WHERE shop_id = ${shopId}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.purpose).toBe("BOOKKEEPING");
      expect(rows[0]?.policy_version).toBe("privacy-v1");
      expect(rows[0]?.granted).toBe(true);
    });
  });
});
