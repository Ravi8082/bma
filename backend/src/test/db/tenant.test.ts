import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getPool } from "../../config/db";
import { queryWithoutTenant, withTenant, type TenantContext, type TenantDb } from "../../db/tenant";
import { sql } from "../../db/sql";
import { usePostgres } from "../helpers/postgres";

usePostgres();

function context(shopId: string, readOnly = false): TenantContext {
  return {
    shopId,
    actorType: "SYSTEM",
    actorId: `test-${randomUUID()}`,
    readOnly,
  };
}

describe("withTenant()", () => {
  it("fails closed when no tenant context is set", async () => {
    const rows = await queryWithoutTenant<{ id: string }>(sql`SELECT id FROM app.shops`);
    expect(rows).toHaveLength(0);

    const shopId = randomUUID();
    const client = await getPool().connect();
    try {
      await expect(
        client.query({
          text: `INSERT INTO app.shops (id, name, slug, preset_key) VALUES ($1, $2, $3, $4)`,
          values: [shopId, "No context", `no-context-${shopId.slice(0, 8)}`, "FLOWER_SELLER"],
        }),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });

  it("runs a tenant query inside the context and clears it afterwards", async () => {
    const ctx: TenantContext = context(randomUUID());
    const rows = await withTenant(ctx, async (db: TenantDb) => {
      const setting = await db.query<{ shop_id: string | null }>(
        sql`SELECT current_setting('app.shop_id', true) AS shop_id`,
      );
      const shops = await db.query<{ id: string }>(sql`SELECT id FROM app.shops LIMIT 1`);
      return { setting: setting[0]?.shop_id ?? null, shops };
    });

    expect(rows.setting).toBe(ctx.shopId);
    expect(Array.isArray(rows.shops)).toBe(true);
  });

  it("rejects writes inside a read-only tenant context", async () => {
    const ctx: TenantContext = context(randomUUID(), true);
    await expect(
      withTenant(ctx, async (db: TenantDb) => {
        await db.execute(
          sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${randomUUID()}, 'Read only', 'read-only', 'FLOWER_SELLER')`,
        );
      }),
    ).rejects.toThrow();
  });
});
