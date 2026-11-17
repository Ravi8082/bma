import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { deliverButton, ledgerCount, outboxRows, seedDraft, seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

describe("evening summary button ownership", () => {
  it("rejects a confirm_all tap for a batch that does not belong to the shop", async () => {
    const shop = await seedShop();
    await seedDraft(shop, { customerName: "Ramesh", amountPaise: 30_000, entryIndex: 0 });

    const foreignBatchId = "00000000-0000-0000-0000-000000000000";
    await deliverButton(shop.shopId, shop.phone, `confirm_all:${foreignBatchId}`, 2);
    await processNextInboxMessageForShop(shop.shopId, {
      parser: deterministicParser,
      keyRef: env.FIELD_ENCRYPTION_KEY_REF,
      blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
      messaging: shop.messaging,
    });

    const replies = (await outboxRows(shop.shopId)).filter((row) =>
      (row.payload.text ?? "").includes("no longer available"),
    );
    expect(replies).toHaveLength(1);
    expect(await ledgerCount(shop.shopId)).toBe(0);
    void sql; void withTenant;
  });
});
