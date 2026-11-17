import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { processNextOutboundForShop } from "../../whatsapp/outboundSender";
import { deterministicParser } from "../../whatsapp/parser";
import {
  deliverText,
  outboxRows,
  seedDraft,
  seedShop,
  type SeededShop,
} from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

function inboundDeps(shop: SeededShop) {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging: shop.messaging,
  };
}

async function summaryRows(shopId: string) {
  const rows = await outboxRows(shopId);
  return rows.filter((row) => row.payload.kind === "EVENING_SUMMARY");
}

describe("stale evening summary replacement", () => {
  it("replaces a summary queued while the window was closed with a fresh one on the next inbound", async () => {
    const shop = await seedShop({ windowClosed: true });
    await seedDraft(shop, { customerName: "Ramesh", amountPaise: 30_000, entryIndex: 0 });

    // Queue the summary while the 24-hour window is closed.
    const { runEveningForShop } = await import("../../whatsapp/eveningScheduler");
    const outcome = await runEveningForShop(shop.shopId, "2026-06-15", {
      keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    });
    expect(outcome).toBe("ran");

    const before = await summaryRows(shop.shopId);
    expect(before).toHaveLength(1);
    const oldBatchId = before[0]!.payload.batchId;
    const oldId = before[0]!.id;

    // Window is still closed and there is no template, so the sender leaves it queued.
    const sendResult = await processNextOutboundForShop(shop.shopId, {
      messaging: shop.messaging,
      keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    });
    expect(sendResult.state).toBe("QUEUED");

    // The seller messages again; the stale summary must be retired and a fresh one queued.
    await deliverText(shop.shopId, shop.phone, "Sita 200 udhaar", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop));

    const after = await summaryRows(shop.shopId);
    expect(after).toHaveLength(2);

    const retired = after.find((row) => row.id === oldId)!;
    expect(retired.state).toBe("DEAD");
    expect(retired.last_error).toBe("SUPERSEDED");

    const fresh = after.find((row) => row.id !== oldId)!;
    expect(fresh.payload.batchId).not.toBe(oldBatchId);
    expect(["QUEUED", "SENT"]).toContain(fresh.state);
  });
});
