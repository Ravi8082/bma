import { describe, expect, it } from "vitest";
import { usePostgres } from "../../test/helpers/postgres";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { randomUUID } from "node:crypto";
import { findOrCreateCustomer, attachPhone, normaliseName } from "./customers";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { env } from "../../config/env";

usePostgres();

async function seedShop(): Promise<string> {
  const shopId = randomUUID();
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test', ${`t-${shopId.slice(0,8)}`}, 'FLOWER_SELLER')`);
  });
  return shopId;
}

describe("customers module", () => {
  it("normalises names", () => {
    expect(normaliseName("  Ramesh  ")).toBe("ramesh");
    expect(normaliseName("Ramesh Kumar")).toBe("ramesh kumar");
  });

  it("creates a customer on first mention and reuses on second", async () => {
    const shopId = await seedShop();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      const first = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      expect(first.ambiguous).toBe(false);
      const second = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      expect(second.ambiguous).toBe(false);
      expect(second.customerId).toBe(first.customerId);
    });
  });

  it("flags ambiguity when two customers share a normalised name", async () => {
    const shopId = await seedShop();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      const a = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      // Insert a second customer with the same normalised name directly.
      await db.execute(sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, balance_paise) VALUES (${randomUUID()}, ${shopId}, 'Ramesh 2', 'ramesh', 0)`);
      const c = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      expect(c.ambiguous).toBe(true);
      expect(c.customerId).toBeNull();
      expect(c.candidateIds.length).toBe(2);
      void a;
    });
  });

  it("attaches a phone and rejects a duplicate phone in the same shop", async () => {
    const shopId = await seedShop();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      const a = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      const b = await findOrCreateCustomer(db, shopId, "Suresh", env.PHONE_BLIND_INDEX_KEY);
      const r1 = await attachPhone(db, shopId, a.customerId!, "+919876543210", env.FIELD_ENCRYPTION_KEY_REF, env.PHONE_BLIND_INDEX_KEY);
      expect(r1.ok).toBe(true);
      const r2 = await attachPhone(db, shopId, b.customerId!, "+919876543210", env.FIELD_ENCRYPTION_KEY_REF, env.PHONE_BLIND_INDEX_KEY);
      expect(r2.ok).toBe(false);
      expect(r2.reason).toBe("PHONE_ALREADY_USED");
    });
  });

  it("rejects an invalid phone", async () => {
    const shopId = await seedShop();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      const a = await findOrCreateCustomer(db, shopId, "Ramesh", env.PHONE_BLIND_INDEX_KEY);
      const r = await attachPhone(db, shopId, a.customerId!, "not-a-phone", env.FIELD_ENCRYPTION_KEY_REF, env.PHONE_BLIND_INDEX_KEY);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("INVALID_PHONE");
    });
  });
});
