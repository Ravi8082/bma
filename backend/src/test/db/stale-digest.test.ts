import { randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { enqueueOutbound } from "../../whatsapp/outbound";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { usePostgres } from "../helpers/postgres";
import request from "supertest";

usePostgres();



describe("stale-message digest on next inbound", () => {
  it("shows a pending digest when queued messages are older than 24h", async () => {
    const phone = `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
    const shopId = randomUUID();
    const userId = randomUUID();
    const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
    const enc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "users", column: "phone_enc" });
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test shop', ${`t-${shopId.slice(0,8)}`}, 'FLOWER_SELLER')`);
      await db.execute(sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status) VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${enc}, ${bidx}, 1, 'ACTIVE')`);
      await db.execute(sql`INSERT INTO app.shop_settings (shop_id, preset_key, language) VALUES (${shopId}, 'FLOWER_SELLER', 'hi')`);
      await db.execute(sql`INSERT INTO app.consent_records (shop_id, user_id, purpose, granted, policy_version, method) VALUES (${shopId}, ${userId}, 'BOOKKEEPING', true, 'privacy-v2', 'WHATSAPP')`);
    });
    const obEnc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "outbox_events", column: "recipient_phone_enc" });
    const id = await enqueueOutbound({ shopId, recipientPhoneBidx: bidx, recipientPhoneEnc: obEnc, keyVersion: 1, messageType: "TEXT", payload: { to: phone, body: "stale msg" } });
    // age it
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(sql`UPDATE app.outbox_events SET queued_at = now() - interval '25 hours' WHERE id = ${id}`);
    });
    const store = new SimulatorStore();
    const messaging = new SimulatorMessagingProvider(store);
    const app = createApp({ webhook: { appSecret: "test-app-secret", verifyToken: "test-verify-token" } });
    const waId = `wamid.${randomUUID()}`;
    const payload = { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: waId, from: phone.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Ramesh 300 udhaar" } }] } }] }] };
    const raw = JSON.stringify(payload);
    const { createHmac } = await import("node:crypto");
    const sig = `sha256=${createHmac("sha256", "test-app-secret").update(raw).digest("hex")}`;
    await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sig).send(raw);
    const deps = { parser: deterministicParser, keyRef: env.FIELD_ENCRYPTION_KEY_REF, blindIndexKey: env.PHONE_BLIND_INDEX_KEY, messaging };
    const r = await processNextInboxMessageForShop(shopId, deps);
    expect(r.outcome).toBe("DONE");
    const msgs = store.list({ to: phone }).map((m: { body: string }) => m.body);
    expect(msgs.some((m: string) => m.includes("Pending while you were away"))).toBe(true);
  });
});