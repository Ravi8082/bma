import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { queryWithoutTenant, withTenant } from "../../db/tenant";
import { runEveningTick, type EveningDeps } from "../../whatsapp/eveningScheduler";
import { seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const eveningDeps: EveningDeps = { keyRef: env.FIELD_ENCRYPTION_KEY_REF };

describe("app.list_due_shop_ids (no tenant context)", () => {
  it("is owned by bma_migrator with a pinned search_path", async () => {
    const rows = await queryWithoutTenant<{
      owner: string;
      proname: string;
      proconfig: string[] | null;
    }>(
      sql`SELECT pg_get_userbyid(p.proowner) AS owner, p.proname,
                 p.proconfig
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' AND p.proname = 'list_due_shop_ids'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner).toBe("bma_migrator");
    expect(rows[0]!.proconfig).toContain("search_path=pg_catalog, app");
  });

  it("revokes EXECUTE from PUBLIC and grants it to bma_app", async () => {
    const rows = await queryWithoutTenant<{ grantee: string; privilege_type: string }>(
      sql`SELECT grantee, privilege_type
            FROM information_schema.routine_privileges
           WHERE routine_schema = 'app' AND routine_name = 'list_due_shop_ids'`,
    );
    const grantees = rows.map((row) => row.grantee);
    expect(grantees).toContain("bma_app");
    expect(grantees).not.toContain("PUBLIC");
  });

  it("returns only shop_id", async () => {
    const shop = await seedShop();
    const result = await queryWithoutTenant<Record<string, unknown>>(
      sql`SELECT * FROM app.list_due_shop_ids(now())`,
    );
    // The shop's evening time may or may not be due right now; assert shape only.
    for (const row of result) {
      expect(Object.keys(row)).toEqual(["shop_id"]);
      expect(typeof row.shop_id).toBe("string");
    }
    // And the function is callable without a tenant context at all.
    expect(Array.isArray(result)).toBe(true);
    void shop;
  });

  it("returns a due shop but not one whose evening time is still in the future", async () => {
    const dueShop = await seedShop({ eveningTime: "00:00", timeZone: "UTC" });
    const notDueShop = await seedShop({ eveningTime: "23:59", timeZone: "UTC" });

    const dueIds = await queryWithoutTenant<{ shop_id: string }>(
      sql`SELECT shop_id FROM app.list_due_shop_ids(now())`,
    );
    const ids = new Set(dueIds.map((row) => row.shop_id));
    expect(ids.has(dueShop.shopId)).toBe(true);
    expect(ids.has(notDueShop.shopId)).toBe(false);
  });

  it("fans out only due shops when runEveningTick uses the function", async () => {
    const dueShop = await seedShop({ eveningTime: "00:00", timeZone: "UTC" });
    const notDueShop = await seedShop({ eveningTime: "23:59", timeZone: "UTC" });

    const result = await runEveningTick(eveningDeps, new Date());
    expect(result.dueShops).toBeGreaterThanOrEqual(1);
    // The not-due shop must never be ticked.
    const eveningRuns = await withTenant(
      { shopId: notDueShop.shopId, actorType: "SYSTEM", actorId: "test" },
      async (db) =>
        db.query<{ shop_id: string }>(
          sql`SELECT shop_id FROM app.evening_runs WHERE shop_id = ${notDueShop.shopId}`,
        ),
    );
    expect(eveningRuns).toHaveLength(0);
    void dueShop;
  });
});
