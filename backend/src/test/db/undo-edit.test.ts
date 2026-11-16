import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { usePostgres } from "../helpers/postgres";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { reverseLedgerEntry } from "../../whatsapp/confirmation";

usePostgres();

describe("undo and edit scenarios (real DB tests)", () => {
  it("undo stale entry id: reverseLedgerEntry throws for unknown id", async () => {
    const shopId = randomUUID();
    await expect(reverseLedgerEntry(shopId, randomUUID(), "x")).rejects.toThrow();
  });
  it("undo foreign entry id: another shop's entry id is not found", async () => {
    const shopId = randomUUID();
    await expect(reverseLedgerEntry(shopId, randomUUID(), "x")).rejects.toThrow();
  });
  it("edit amount: updates amount_paise on pending draft", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'msg', 'SELLER', 'PENDING', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`UPDATE app.entry_drafts SET amount_paise = 50000 WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`);
      const rows = await db.query<{ amount_paise: string }>(sql`SELECT amount_paise FROM app.entry_drafts WHERE id = ${draftId}`);
      expect(Number(rows[0]!.amount_paise)).toBe(50000);
    });
  });
  it("edit name: updates customer_name on pending draft", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'msg', 'SELLER', 'PENDING', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`UPDATE app.entry_drafts SET customer_name = 'Suresh' WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`);
      const rows = await db.query<{ customer_name: string }>(sql`SELECT customer_name FROM app.entry_drafts WHERE id = ${draftId}`);
      expect(rows[0]!.customer_name).toBe("Suresh");
    });
  });
  it("edit type: updates is_credit_sale and clears type_unclear", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, true, 'msg', 'SELLER', 'PENDING', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`UPDATE app.entry_drafts SET is_credit_sale = false, type_unclear = false WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`);
      const rows = await db.query<{ is_credit_sale: boolean; type_unclear: boolean }>(sql`SELECT is_credit_sale, type_unclear FROM app.entry_drafts WHERE id = ${draftId}`);
      expect(rows[0]!.is_credit_sale).toBe(false);
      expect(rows[0]!.type_unclear).toBe(false);
    });
  });
  it("edit after confirm: rejected (status not PENDING)", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'msg', 'SELLER', 'CONFIRMED', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`UPDATE app.entry_drafts SET customer_name = 'X' WHERE shop_id = ${shopId} AND id = ${draftId} AND status = 'PENDING'`);
      const rows = await db.query<{ customer_name: string }>(sql`SELECT customer_name FROM app.entry_drafts WHERE id = ${draftId}`);
      expect(rows[0]!.customer_name).toBe("Ramesh");
    });
  });
  it("pending edit restart persistence: row survives in app.pending_edits", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'msg', 'SELLER', 'PENDING', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`INSERT INTO app.pending_edits (shop_id, draft_id, field, expires_at) VALUES (${shopId}, ${draftId}, 'amount', now() + interval '2 minutes')`);
      const rows = await db.query<{ field: string }>(sql`SELECT field FROM app.pending_edits WHERE shop_id = ${shopId}`);
      expect(rows[0]!.field).toBe("amount");
    });
  });
  it("pending edit expiry: expired rows are ignored", async () => {
    const shopId = randomUUID();
    const draftId = randomUUID();
    const msgId = randomUUID();
    const bidx = Buffer.from("x");
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version) VALUES (${draftId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Ramesh', 'SALE', 'DEBIT', 30000, true, false, 'msg', 'SELLER', 'PENDING', ${bidx}, ${bidx}, 1)`);
      await db.execute(sql`INSERT INTO app.pending_edits (shop_id, draft_id, field, expires_at) VALUES (${shopId}, ${draftId}, 'amount', now() - interval '1 minute')`);
      const rows = await db.query<{ id: string }>(sql`SELECT id FROM app.pending_edits WHERE shop_id = ${shopId} AND expires_at > now()`);
      expect(rows.length).toBe(0);
    });
  });
});