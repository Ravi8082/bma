import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { getPool, withTransaction } from "../../config/db";
import { queryWithoutTenant, withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { processNextOutboundForShop } from "../../whatsapp/outboundSender";
import { enqueueOutbound } from "../../whatsapp/outbound";
import { deterministicParser } from "../../whatsapp/parser";
import { usePostgres } from "../helpers/postgres";
import request from "supertest";

usePostgres();

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const store = new SimulatorStore();
const deps = { parser: deterministicParser, keyRef: env.FIELD_ENCRYPTION_KEY_REF, blindIndexKey: env.PHONE_BLIND_INDEX_KEY };

function uniqueSellerPhone(): string { return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`; }

async function seedSeller(phone: string): Promise<string> {
  const shopId = randomUUID();
  const userId = randomUUID();
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const enc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "users", column: "phone_enc" });
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test shop', ${`t-${shopId.slice(0,8)}`}, 'FLOWER_SELLER')`);
    await db.execute(sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status) VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${enc}, ${bidx}, 1, 'ACTIVE')`);
    await db.execute(sql`INSERT INTO app.shop_settings (shop_id, preset_key, language) VALUES (${shopId}, 'FLOWER_SELLER', 'hi')`);
    // privacy-v1 consent -> re-consent required
    await db.execute(sql`INSERT INTO app.consent_records (shop_id, user_id, purpose, granted, policy_version, method) VALUES (${shopId}, ${userId}, 'BOOKKEEPING', true, 'privacy-v1', 'WHATSAPP')`);
  });
  return shopId;
}

function sign(raw: string): string {
  const { createHmac } = require("node:crypto");
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

describe("4a-2 item 1: consent wiring", () => {
  it("re-requests consent and does not process the entry when version is not privacy-v2", async () => {
    const phone = uniqueSellerPhone();
    const shopId = await seedSeller(phone);
    const app = createApp({ webhook: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } });
    const waId = `wamid.${randomUUID()}`;
    const payload = { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: waId, from: phone.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Ramesh 300 udhaar" } }] } }] }] };
    const raw = JSON.stringify(payload);
    const res = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sign(raw)).send(raw);
    expect(res.status).toBe(200);

    const result = await processNextInboxMessageForShop(shopId, deps);
    expect(result.outcome).toBe("DONE");
    // No draft created
    const d = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ count: string }>(sql`SELECT COUNT(*) AS count FROM app.entry_drafts WHERE shop_id = ${shopId}`));
    expect(Number(d[0]?.count ?? "0")).toBe(0);
    // Consent re-request queued
    const queued = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ payload: any }>(sql`SELECT payload FROM app.outbox_events WHERE shop_id = ${shopId}`));
    expect(queued.some((r) => JSON.stringify(r.payload).includes("re-accept the updated privacy terms"))).toBe(true);
  });
});

describe("4a-2 item 2: 24-hour window handling", () => {
  it("re-queues an outbound message instead of dropping it when the window is closed", async () => {
    const phone = uniqueSellerPhone();
    const shopId = await seedSeller(phone);
    // No inbound in the last 24h (window closed), no template configured.
    const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "outbox_events", column: "recipient_phone_enc" });
    const id = await enqueueOutbound({ shopId, recipientPhoneBidx: bidx, recipientPhoneEnc: enc, keyVersion: 1, messageType: "TEXT", payload: { to: phone, text: "hi" } });
    expect(id).toBeTruthy();

    const r = await processNextOutboundForShop(shopId, { messaging: new SimulatorMessagingProvider(store), keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(r.state).toBe("QUEUED");
    // Message is not dropped: still in the outbox, not SENT.
    const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => db.query<{ state: string }>(sql`SELECT state FROM app.outbox_events WHERE id = ${id}`));
    expect(rows[0]?.state).toBe("QUEUED");
    // Simulator store has nothing (not sent).
    expect(store.list({ to: phone })).toHaveLength(0);
  });
});
