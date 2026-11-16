import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { usePostgres } from "../helpers/postgres";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { env } from "../../config/env";
import { createBatch, confirmAllBatch, batchEntryVersions, reviewBatchPage } from "../../whatsapp/batch";

usePostgres();

describe("evening batch: snapshot, version check, typeUnclear gate", () => {
  it("creates a batch snapshot with a batch id and entry list", async () => {
    const shopId = randomUUID();
    const bidx = phoneBlindIndex("+919876543210", env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField("+919876543210", env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const msgId = randomUUID();
    const d1 = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${d1}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'Ramesh 300 udhaar', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1)`);
    });
    const batch = await createBatch(shopId, [d1]);
    expect(batch.batchId).toBeTruthy();
    expect(batch.draftIds).toEqual([d1]);
    const versions = await batchEntryVersions(shopId, batch.batchId);
    expect(versions).toHaveLength(1);
  });

  it("Confirm all blocks typeUnclear entries and confirms the rest with version check", async () => {
    const shopId = randomUUID();
    const bidx = phoneBlindIndex("+919876543210", env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField("+919876543210", env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const msgId = randomUUID();
    const d1 = randomUUID();
    const d2 = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version, entry_index) VALUES (${d1}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'Ramesh 300 udhaar', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1, 0)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version, entry_index) VALUES (${d2}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Meena', 'SALE', 'DEBIT', 15000, false, true, 'Meena 150 cash', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1, 1)`);
    });
    const batch = await createBatch(shopId, [d1, d2]);
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    const res = await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    expect(res.confirmed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.totalPaise).toBe(30000);
    const page = await reviewBatchPage(shopId, batch.batchId, 0, 10);
    expect(page.total).toBe(2);
  });
});