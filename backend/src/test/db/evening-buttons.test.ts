import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { runEveningForShop, type EveningDeps } from "../../whatsapp/eveningScheduler";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import {
  deliverButton,
  ledgerCount,
  outboxRows,
  seedDraft,
  seedShop,
  type SeededShop,
} from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const eveningDeps: EveningDeps = { keyRef: env.FIELD_ENCRYPTION_KEY_REF };

function inboundDeps(shop: SeededShop) {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging: shop.messaging,
  };
}

async function draftStates(
  shopId: string,
): Promise<Array<{ id: string; status: string; batch_id: string | null }>> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ id: string; status: string; batch_id: string | null }>(
      sql`SELECT id, status, batch_id FROM app.entry_drafts
           WHERE shop_id = ${shopId} ORDER BY created_at, entry_index`,
    ),
  );
}

async function summaryRow(shopId: string) {
  const rows = await outboxRows(shopId);
  return rows.find((row) => row.payload.kind === "EVENING_SUMMARY");
}

describe("evening summary buttons", () => {
  it("sends Confirm all and Review, and posts no ledger row before the tap", async () => {
    const shop = await seedShop();
    await seedDraft(shop, { customerName: "Ramesh", amountPaise: 30_000, entryIndex: 0 });
    await seedDraft(shop, { customerName: "Sita", amountPaise: 20_000, entryIndex: 1 });

    const outcome = await runEveningForShop(shop.shopId, "2026-06-15", eveningDeps);
    expect(outcome).toBe("ran");

    const summary = await summaryRow(shop.shopId);
    expect(summary).toBeDefined();
    const batchId = summary!.payload.batchId;
    expect(typeof batchId).toBe("string");
    expect(summary!.payload.text).toBe("Evening summary: 2 entries, total ₹500.");
    expect(summary!.payload.buttons).toEqual([
      { id: `confirm_all:${batchId}`, title: "Confirm all" },
      { id: `review:${batchId}`, title: "Review" },
    ]);

    // The summary only snapshots drafts; money is posted by the seller's tap.
    expect(await ledgerCount(shop.shopId)).toBe(0);
    for (const draft of await draftStates(shop.shopId)) {
      expect(draft.status).toBe("PENDING");
      expect(draft.batch_id).toBe(batchId);
    }
  });

  it("posts exactly one ledger row per entry after the tap, and nothing on a repeat tap", async () => {
    const shop = await seedShop();
    await seedDraft(shop, { customerName: "Ramesh", amountPaise: 30_000, entryIndex: 0 });
    await seedDraft(shop, { customerName: "Sita", amountPaise: 20_000, entryIndex: 1 });

    await runEveningForShop(shop.shopId, "2026-06-15", eveningDeps);
    const batchId = (await summaryRow(shop.shopId))!.payload.batchId!;
    expect(await ledgerCount(shop.shopId)).toBe(0);

    await deliverButton(shop.shopId, shop.phone, `confirm_all:${batchId}`, 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop));

    expect(await ledgerCount(shop.shopId)).toBe(2);
    for (const draft of await draftStates(shop.shopId)) {
      expect(draft.status).toBe("CONFIRMED");
    }

    // A second tap finds the drafts already confirmed and posts no extra money.
    await deliverButton(shop.shopId, shop.phone, `confirm_all:${batchId}`, 3);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop));

    expect(await ledgerCount(shop.shopId)).toBe(2);
    const replies = (await outboxRows(shop.shopId)).filter((row) =>
      (row.payload.text ?? "").startsWith("Confirmed 0 entries"),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload.text).toContain("2 skipped");
  });

  it("Review lists the batch with a Confirm all button and posts nothing", async () => {
    const shop = await seedShop();
    await seedDraft(shop, { customerName: "Ramesh", amountPaise: 30_000, entryIndex: 0 });
    await seedDraft(shop, { customerName: "Sita", amountPaise: 20_000, entryIndex: 1 });

    await runEveningForShop(shop.shopId, "2026-06-15", eveningDeps);
    const batchId = (await summaryRow(shop.shopId))!.payload.batchId!;

    await deliverButton(shop.shopId, shop.phone, `review:${batchId}`, 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop));

    const review = (await outboxRows(shop.shopId)).find((row) =>
      (row.payload.text ?? "").startsWith("Review (page 1 of 1):"),
    );
    expect(review).toBeDefined();
    expect(review!.payload.text).toContain("Review (page 1 of 1):");
    expect(review!.payload.text).toContain("₹300 credit sale for Ramesh (pending)");
    expect(review!.payload.text).toContain("₹200 credit sale for Sita (pending)");
    expect(review!.payload.buttons).toEqual([
      { id: `confirm_all:${batchId}`, title: "Confirm all" },
    ]);
    expect(await ledgerCount(shop.shopId)).toBe(0);
  });
});
