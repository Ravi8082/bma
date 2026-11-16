import { createHmac, randomInt, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { getPool } from "../../config/db";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { processNextInboxMessageForShop, type InboundDeps } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { LlmExtractionParser, type LlmProvider } from "../../whatsapp/extraction";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const store = new SimulatorStore();

function uniqueSellerPhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

async function seedSeller(phone: string): Promise<string> {
  const shopId = randomUUID();
  const userId = randomUUID();
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const enc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, { shopId, table: "users", column: "phone_enc" });
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(sql`INSERT INTO app.shops (id, name, slug, preset_key) VALUES (${shopId}, 'Test shop', ${`t-${shopId.slice(0,8)}`}, 'FLOWER_SELLER')`);
    await db.execute(sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status) VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${enc}, ${bidx}, 1, 'ACTIVE')`);
  });
  return shopId;
}

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

describe("A6: no DB transaction open during LLM call", () => {
  it("asserts pg_stat_activity has no idle-in-transaction during extraction", async () => {
    const phone = uniqueSellerPhone();
    const shopId = await seedSeller(phone);
    const app = createApp({ webhook: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } });
    const waId = `wamid.${randomUUID()}`;
    const payload = { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [{ id: waId, from: phone.replace(/^\+/, ""), timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Ramesh 300 udhaar" } }] } }] }] };
    const raw = JSON.stringify(payload);
    const res = await request(app).post("/webhooks/whatsapp").set("content-type", "application/json").set("x-hub-signature-256", sign(raw)).send(raw);
    expect(res.status).toBe(200);

    class CheckingProvider {
      readonly name = "checking";
      readonly model = "checking-v1";
      async extract(input: { text: string }): Promise<{ raw: string; promptTokens: number; completionTokens: number }> {
        const client = await getPool().connect();
        try {
          const rows = await client.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM pg_stat_activity WHERE state = 'idle in transaction' AND application_name = 'bma-api'",
          );
          expect(Number(rows.rows[0]?.count ?? "0")).toBe(0);
          const locks = await client.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'bma-api' AND l.locktype = 'advisory'",
          );
          expect(Number(locks.rows[0]?.count ?? "0")).toBe(0);
        } finally {
          client.release();
        }
        const det = deterministicParser.parse(input.text);
        const entry = det.kind === "PARSED" ? det.entry : null;
        const raw = JSON.stringify({ customerName: entry?.customerName ?? "X", amountPaise: entry?.amountPaise ?? 100, entryType: entry?.entryType ?? "SALE", isCreditSale: entry?.isCreditSale ?? true, typeUnclear: entry?.typeUnclear ?? false });
        return { raw, promptTokens: 0, completionTokens: 0 };
      }
    }

    const provider = new CheckingProvider();
    const parser = new LlmExtractionParser(provider as unknown as LlmProvider, shopId, { isOpen: () => false, recordFailure: () => {}, recordSuccess: () => {} }, 1000, { callsToday: 0 });
    const deps = { parser, keyRef: env.FIELD_ENCRYPTION_KEY_REF, blindIndexKey: env.PHONE_BLIND_INDEX_KEY, messaging: new SimulatorMessagingProvider(store) };
    const result = await processNextInboxMessageForShop(shopId, deps as unknown as InboundDeps);
    expect(result.outcome).toBe("DONE");
  });
});
