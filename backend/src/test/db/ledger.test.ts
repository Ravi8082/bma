import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withTenant, type TenantContext, type TenantDb } from "../../db/tenant";
import { toDatabasePaise, paise } from "@bma/shared";
import { sql } from "../../db/sql";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const MAX_AMOUNT_PAISE = 100_000_000_000; // configured ceiling for one entry (₹10 crore)

async function insertLedger(
  db: TenantDb,
  input: {
    shopId: string;
    customerId: string;
    direction: "DEBIT" | "CREDIT";
    amountPaise: number;
    idempotencyKey: string;
  },
): Promise<void> {
  await db.execute(
    sql`INSERT INTO app.ledger_entries
          (shop_id, customer_id, posting_id, entry_seq, entry_type, direction, amount_paise, occurred_at, source, idempotency_key, created_by)
         VALUES
          (${input.shopId}, ${input.customerId}, ${randomUUID()}, 1, 'SALE', ${input.direction}, ${toDatabasePaise(paise(input.amountPaise))}, ${new Date("2026-11-13T10:00:00Z")}, 'WHATSAPP', ${input.idempotencyKey}, 'test')`,
  );
}

function contextFor(shopId: string): TenantContext {
  return { shopId, actorType: "SYSTEM", actorId: `test-${randomUUID()}` };
}

async function createShopAndCustomer(shopId: string): Promise<string> {
  const ctx: TenantContext = contextFor(shopId);
  return withTenant(ctx, async (db: TenantDb) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test seller', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER')`,
    );
    const customerId = randomUUID();
    await db.execute(
      sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, balance_paise) VALUES (${customerId}, ${shopId}, 'Rahul', 'rahul', 0)`,
    );
    return customerId;
  });
}

describe("ledger_entries (PostgreSQL)", () => {
  it("stores money as an exact BIGINT paise integer and sums without drift", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);

    const ctx: TenantContext = contextFor(shopId);
    await withTenant(ctx, async (db: TenantDb) => {
      await insertLedger(db, { shopId, customerId, direction: "DEBIT", amountPaise: 150_000_050, idempotencyKey: `idem-${randomUUID()}` });

      const rows = await db.query<{ total: string | null; count: string }>(
        sql`SELECT SUM(amount_paise) AS total, COUNT(*) AS count FROM app.ledger_entries WHERE shop_id = ${shopId}`,
      );
      const total = rows[0];
      expect(total).toBeDefined();
      expect(Number(total?.total ?? "0")).toBe(150_000_050);
      expect(Number(total?.count)).toBeGreaterThanOrEqual(1);
    });
  });

  it("refuses a negative amount (non-negative rule)", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);
    const ctx: TenantContext = contextFor(shopId);

    await expect(
      withTenant(ctx, async (db: TenantDb) => {
        await insertLedger(db, { shopId, customerId, direction: "DEBIT", amountPaise: -1, idempotencyKey: `idem-${randomUUID()}` });
      }),
    ).rejects.toThrow(/amount_paise/i);
  });

  it("refuses an amount above the configured ceiling", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);
    const ctx: TenantContext = contextFor(shopId);

    await expect(
      withTenant(ctx, async (db: TenantDb) => {
        await insertLedger(db, { shopId, customerId, direction: "CREDIT", amountPaise: MAX_AMOUNT_PAISE + 1, idempotencyKey: `idem-${randomUUID()}` });
      }),
    ).rejects.toThrow(/amount_paise/i);
  });

  it("rejects a duplicate idempotency key for the same shop", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);
    const ctx: TenantContext = contextFor(shopId);
    const idempotencyKey = `idem-${randomUUID()}`;

    await withTenant(ctx, async (db: TenantDb) => {
      await insertLedger(db, { shopId, customerId, direction: "DEBIT", amountPaise: 1_000, idempotencyKey });
    });
    await expect(
      withTenant(ctx, async (db: TenantDb) => {
        await insertLedger(db, { shopId, customerId, direction: "DEBIT", amountPaise: 1_000, idempotencyKey });
      }),
    ).rejects.toThrow(/idempotency/i);
  });

  it("rejects updates and deletes on the append-only ledger", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);
    const ctx: TenantContext = contextFor(shopId);
    let ledgerId = "";

    await withTenant(ctx, async (db: TenantDb) => {
      const rows = await db.query<{ id: string }>(
        sql`INSERT INTO app.ledger_entries (shop_id, customer_id, posting_id, entry_seq, entry_type, direction, amount_paise, occurred_at, source, idempotency_key, created_by)
             VALUES (${shopId}, ${customerId}, ${randomUUID()}, 1, 'SALE', 'DEBIT', 100, ${new Date("2026-11-13T10:00:00Z")}, 'WHATSAPP', ${`idem-${randomUUID()}`}, 'test')
             RETURNING id`,
      );
      ledgerId = rows[0]?.id ?? "";
    });

    await expect(
      withTenant(contextFor(shopId), async (db: TenantDb) => {
        await db.execute(sql`UPDATE app.ledger_entries SET amount_paise = 0 WHERE id = ${ledgerId}`);
      }),
    ).rejects.toThrow();
    await expect(
      withTenant(contextFor(shopId), async (db: TenantDb) => {
        await db.execute(sql`DELETE FROM app.ledger_entries WHERE id = ${ledgerId}`);
      }),
    ).rejects.toThrow();
  });

  it("rejects a cross-shop ledger insert from another tenant context", async () => {
    const shopId = randomUUID();
    const customerId = await createShopAndCustomer(shopId);
    const otherShopId = randomUUID();
    const ctx: TenantContext = contextFor(otherShopId);

    await expect(
      withTenant(ctx, async (db: TenantDb) => {
        await insertLedger(db, { shopId, customerId, direction: "DEBIT", amountPaise: 100, idempotencyKey: `idem-${randomUUID()}` });
      }),
    ).rejects.toThrow();
  });

  it("keeps ledger rows of different shops isolated", async () => {
    const shopA = randomUUID();
    const shopB = randomUUID();
    const customerA = await createShopAndCustomer(shopA);
    const customerB = await createShopAndCustomer(shopB);

    const ctxA: TenantContext = contextFor(shopA);
    const ctxB: TenantContext = contextFor(shopB);
    const idempotencyKeyA = `idem-${randomUUID()}`;
    const idempotencyKeyB = `idem-${randomUUID()}`;

    await withTenant(ctxA, async (db: TenantDb) => {
      await insertLedger(db, { shopId: shopA, customerId: customerA, direction: "DEBIT", amountPaise: 1_250, idempotencyKey: idempotencyKeyA });
    });
    await withTenant(ctxB, async (db: TenantDb) => {
      await insertLedger(db, { shopId: shopB, customerId: customerB, direction: "CREDIT", amountPaise: 9_750, idempotencyKey: idempotencyKeyB });
    });

    const rowsA = await withTenant(ctxA, async (db: TenantDb) => {
      return db.query<{ amount_paise: string; direction: string }>(
        sql`SELECT amount_paise, direction FROM app.ledger_entries WHERE shop_id = ${shopA}`,
      );
    });
    const rowsB = await withTenant(ctxB, async (db: TenantDb) => {
      return db.query<{ amount_paise: string; direction: string }>(
        sql`SELECT amount_paise, direction FROM app.ledger_entries WHERE shop_id = ${shopB}`,
      );
    });

    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]?.amount_paise).toBe("9750");
  });
});
