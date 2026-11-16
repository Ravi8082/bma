import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { usePostgres } from "../helpers/postgres";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { env } from "../../config/env";
import { confirmDraft } from "../../whatsapp/confirmation";

usePostgres();

describe("confirmation: typeUnclear gate and inline phone attach", () => {
  it("typeUnclear draft cannot be confirmed via immediate confirmDraft (TYPE_UNCLEAR)", async () => {
    const shopId = randomUUID();
    const sellerPhone = "+919876543210";
    const bidx = phoneBlindIndex(sellerPhone, env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField(sellerPhone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const draftId = randomUUID();
    const msgId = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, true, 'Ramesh 300 udhaar', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1)`);
    });
    const res = await confirmDraft(shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(res.status).toBe("TYPE_UNCLEAR");
  });

  it("inline phone is attached to the customer only after confirm", async () => {
    const shopId = randomUUID();
    const sellerPhone = "+919876543210";
    const customerPhone = "+919876543211";
    const bidx = phoneBlindIndex(sellerPhone, env.PHONE_BLIND_INDEX_KEY);
    const sellerEnc = encryptField(sellerPhone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const custPhoneEnc = encryptField(customerPhone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "customer_phone_enc" });
    const custPhoneBidx = phoneBlindIndex(customerPhone, env.PHONE_BLIND_INDEX_KEY);
    const draftId = randomUUID();
    const msgId = randomUUID();
    const customerId = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, key_version, balance_paise) VALUES (${customerId}, ${shopId}, 'Ramesh', 'ramesh', 1, 0)`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, customer_phone_enc, customer_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, ${customerId}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'Ramesh 9876543210 300 udhaar', 'SELLER', 'PENDING', ${sellerEnc}, ${bidx}, ${custPhoneEnc}, ${custPhoneBidx}, 1)`);
    });
    const res = await confirmDraft(shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(res.status).toBe("CONFIRMED");
    const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ phone_bidx: Buffer | null }>(sql`SELECT phone_bidx FROM app.customers WHERE id = ${customerId}`));
    expect(rows[0]?.phone_bidx).not.toBeNull();
  });

  it("phone already belongs to another customer: draft confirms, phone rejected, seller told", async () => {
    const shopId = randomUUID();
    const sellerPhone = "+919876543210";
    const customerPhone = "+919876543211";
    const otherCustomerId = randomUUID();
    const bidx = phoneBlindIndex(sellerPhone, env.PHONE_BLIND_INDEX_KEY);
    const sellerEnc = encryptField(sellerPhone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const custPhoneEnc = encryptField(customerPhone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "customer_phone_enc" });
    const custPhoneBidx = phoneBlindIndex(customerPhone, env.PHONE_BLIND_INDEX_KEY);
    const draftId = randomUUID();
    const msgId = randomUUID();
    const customerId = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, phone_enc, phone_bidx, key_version, balance_paise) VALUES (${otherCustomerId}, ${shopId}, 'Other', 'other', ${custPhoneEnc}, ${custPhoneBidx}, 1, 0)`);
      await db.execute(sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, key_version, balance_paise) VALUES (${customerId}, ${shopId}, 'Ramesh', 'ramesh', 1, 0)`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, customer_phone_enc, customer_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, ${customerId}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'Ramesh 9876543210 300 udhaar', 'SELLER', 'PENDING', ${sellerEnc}, ${bidx}, ${custPhoneEnc}, ${custPhoneBidx}, 1)`);
    });
    const res = await confirmDraft(shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(res.status).toBe("CONFIRMED");
    // phone not attached to Ramesh (still null) because it belongs to Other
    const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ phone_bidx: Buffer | null }>(sql`SELECT phone_bidx FROM app.customers WHERE id = ${customerId}`));
    expect(rows[0]?.phone_bidx).toBeNull();
  });
});