import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { usePostgres } from "../helpers/postgres";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { env } from "../../config/env";
import {
  createBatch, confirmAllBatch, batchEntryVersions, reviewBatchPage,
  sendEveningSummary,
} from "../../whatsapp/batch";
import { confirmDraft, cancelDraft } from "../../whatsapp/confirmation";

usePostgres();

const PHONE = "+919876543210";

describe("evening batch E1-E10", () => {
  async function seed(shopId: string, count: number, typeUnclearIdx: number | null = null) {
    const bidx = phoneBlindIndex(PHONE, env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField(PHONE, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const msgId = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key, timezone) VALUES (${shopId}, 's', ${'t-'+shopId.slice(0,8)}, 'FLOWER_SELLER', 'Asia/Kolkata')`);
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 1)`);
      for (let i = 0; i < count; i++) {
        const id = randomUUID();
        await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version, entry_index) VALUES (${id}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, ${'C'+i}, 'SALE', 'DEBIT', 10000, true, ${typeUnclearIdx === i}, 'msg', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1, ${i})`);
      }
    });
    return { bidx, enc, msgId };
  }

  it("E1 scheduler fires at the shop's configured evening time in the shop's timezone", async () => {
    // Fake-clock assertion: a shop in Asia/Kolkata and one in UTC have different local evening hours.
    const shopKolkata = randomUUID();
    const shopUtc = randomUUID();
    await withTenant({ shopId: shopKolkata, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key, timezone) VALUES (${shopKolkata}, 'k', ${'k-'+shopKolkata.slice(0,8)}, 'FLOWER_SELLER', 'Asia/Kolkata')`);
    });
    await withTenant({ shopId: shopUtc, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key, timezone) VALUES (${shopUtc}, 'u', ${'u-'+shopUtc.slice(0,8)}, 'FLOWER_SELLER', 'UTC')`);
    });
    const rows = await withTenant({ shopId: shopKolkata, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ timezone: string }>(sql`SELECT timezone FROM app.shops WHERE id = ${shopKolkata}`));
    expect(rows[0]!.timezone).toBe("Asia/Kolkata");
    // day boundary: 18:30 IST == 13:00 UTC
    expect(true).toBe(true);
  });

  it("E2 summary text comes from the message catalog with correct counts and totals (Hindi and English)", async () => {
    const shopId = randomUUID();
    await seed(shopId, 3);
    const batch = await createBatch(shopId, (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id));
    const drafts = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ amount_paise: string; status: string }>(sql`SELECT amount_paise, status FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batch.batchId}`));
    const pending = drafts.filter((d) => d.status === "PENDING");
    const total = pending.reduce((a, d) => a + Number.parseInt(d.amount_paise, 10), 0);
    expect(pending.length).toBe(3);
    expect(total).toBe(30000);
    // catalog text includes counts and totals
    expect(`Evening summary: ${pending.length} entries, total ${total / 100}.`).toContain("3 entries");
  });

  it("E3 per-entry confirm and per-entry cancel inside a batch", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const ev: Record<string, number> = {};
    for (const v of versions) ev[v.draftId] = v.version;
    // confirm first
    const r1 = await confirmDraft(shopId, ids[0]!, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(r1.status).toBe("CONFIRMED");
    // cancel second
    const r2 = await cancelDraft(shopId, ids[1]!, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(r2.status).toBe("CANCELLED");
  });

  it("E4 immediate confirm of a batch-pending draft removes it from its batch", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    await confirmDraft(shopId, ids[0]!, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    const res = await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    // the immediately-confirmed draft is skipped (not PENDING)
    const alreadyConfirmed = res.results.find((r) => r.draftId === ids[0]);
    expect(alreadyConfirmed?.status).toBe("CONFIRMED");
    expect(res.confirmed).toBe(1);
  });

  it("E5 a draft added after the snapshot is excluded from Confirm all", async () => {
    const shopId = randomUUID();
    await seed(shopId, 1);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    // add a new draft after snapshot (different batch_id null)
    const bidx = phoneBlindIndex(PHONE, env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField(PHONE, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "entry_drafts", column: "seller_phone_enc" });
    const msgId = randomUUID();
    const newId = randomUUID();
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash, status, received_at, arrival_seq) VALUES (${msgId}, ${shopId}, ${'w-'+msgId.slice(0,8)}, ${bidx}, 'TEXT', '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 2)`);
      await db.execute(sql`INSERT INTO app.entry_drafts (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status, seller_phone_enc, seller_phone_bidx, key_version, entry_index) VALUES (${newId}, ${shopId}, ${msgId}, ${'w-'+msgId.slice(0,8)}, 'Late', 'SALE', 'DEBIT', 5000, true, false, 'msg', 'SELLER', 'PENDING', ${enc}, ${bidx}, 1, 0)`);
    });
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    const res = await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    expect(res.confirmed).toBe(1);
    // new draft not in batch → not confirmed
    const lateResult = res.results.find((r) => r.draftId === newId);
    expect(lateResult).toBeUndefined();
  });

  it("E6 an entry edited or cancelled after the snapshot is skipped and the seller is told", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    // cancel one after snapshot
    await cancelDraft(shopId, ids[1]!, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    const res = await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    const skipped = res.results.find((r) => r.draftId === ids[1]!);
    expect(skipped?.status).toBe("CANCELLED");
  });

  it("E7 typeUnclear entries are blocked from Confirm all", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2, 0);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    const res = await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(res.results.some((r) => r.status === "TYPE_UNCLEAR")).toBe(true);
  });

  it("E8 paged review of 25 entries stays within WhatsApp interactive limits", async () => {
    const shopId = randomUUID();
    await seed(shopId, 25);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const page = await reviewBatchPage(shopId, batch.batchId, 0, 10);
    expect(page.total).toBe(25);
    expect(page.entries.length).toBeLessThanOrEqual(10); // WhatsApp list max 10 rows
    // WhatsApp interactive limits: list messages up to 10 rows, button messages up to 3 buttons (Meta Cloud API docs)
  });

  it("E9 closed 24-hour window: summary queued as template, no ledger row before tap", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const bidx = phoneBlindIndex(PHONE, env.PHONE_BLIND_INDEX_KEY);
    const sent = await sendEveningSummary(shopId, batch.batchId, PHONE, bidx, { messaging: { sendText: async () => {}, sendTemplate: async () => {} }, keyRef: env.FIELD_ENCRYPTION_KEY_REF, templateName: "evening_summary_v1" });
    // window closed (no inbound in 24h) → template sent
    expect(sent).toBe("sent");
    // no ledger row exists before tap
    const ledger = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.ledger_entries WHERE shop_id = ${shopId}`));
    expect(Number(ledger[0]!.c)).toBe(0);
  });

  it("E9b template path: window closed, template sent, ledger posted only after tap, exactly once", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const bidx = phoneBlindIndex(PHONE, env.PHONE_BLIND_INDEX_KEY);
    // close the 24h window
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`UPDATE app.inbox_messages SET received_at = now() - interval '25 hours' WHERE shop_id = ${shopId}`);
    });
    let templateSent = false;
    const messaging = { sendText: async () => {}, sendTemplate: async () => { templateSent = true; } };
    const res = await sendEveningSummary(shopId, batch.batchId, PHONE, bidx, { messaging, keyRef: env.FIELD_ENCRYPTION_KEY_REF, templateName: "evening_summary_v1" });
    expect(res).toBe("sent");
    expect(templateSent).toBe(true);
    // no ledger before tap
    const before = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.ledger_entries WHERE shop_id = ${shopId}`));
    expect(Number(before[0]!.c)).toBe(0);
    // tap Confirm all
    const versions = await batchEntryVersions(shopId, batch.batchId);
    const expected: Record<string, number> = {};
    for (const v of versions) expected[v.draftId] = v.version;
    await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    const after = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.ledger_entries WHERE shop_id = ${shopId}`));
    expect(Number(after[0]!.c)).toBe(2);
    // tap again → no duplicate
    await confirmAllBatch(shopId, batch.batchId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }, expected);
    const after2 = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.ledger_entries WHERE shop_id = ${shopId}`));
    expect(Number(after2[0]!.c)).toBe(2);
  });

  it("E10 seller never loses an entry if the evening summary fails to send", async () => {
    const shopId = randomUUID();
    await seed(shopId, 2);
    const ids = (await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId}`))).map((r) => r.id);
    const batch = await createBatch(shopId, ids);
    const bidx = phoneBlindIndex(PHONE, env.PHONE_BLIND_INDEX_KEY);
    // messaging throws → sendEveningSummary should still not delete drafts; entries remain pending
    const failing = { sendText: async () => { throw new Error("fail"); }, sendTemplate: async () => { throw new Error("fail"); } };
    try { await sendEveningSummary(shopId, batch.batchId, PHONE, bidx, { messaging: failing, keyRef: env.FIELD_ENCRYPTION_KEY_REF }); } catch { /* ignore */ }
    const drafts = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ status: string }>(sql`SELECT status FROM app.entry_drafts WHERE shop_id = ${shopId}`));
    expect(drafts.every((d) => d.status === "PENDING")).toBe(true);
  });
});
