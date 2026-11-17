import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { StubSttProvider } from "../../integrations/speech/stub";
import { ledgerCount, outboxRows, seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

function inboundDeps(shop: Awaited<ReturnType<typeof seedShop>>, transcript: string) {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging: shop.messaging,
    stt: new StubSttProvider(transcript, "hi"),
    mediaFetcher: async (_mediaId: string) => ({
      buffer: Buffer.from("fake-audio"),
      mimeType: "audio/ogg",
    }),
    sttCostPaisePerMinute: 100,
  };
}

async function deliverAudio(shopId: string, phone: string, mediaId: string, seq: number): Promise<void> {
  const { phoneBlindIndex } = await import("../../crypto/blindIndex");
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const id = (await import("node:crypto")).randomUUID();
  const body = { from: phone, type: "audio", audio: { id: mediaId, mime_type: "audio/ogg" } };
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.inbox_messages
            (id, shop_id, wa_message_id, from_phone_bidx, message_type, body, raw_payload, body_hash,
             status, received_at, arrival_seq)
          VALUES (${id}, ${shopId}, ${`w-${id.slice(0, 8)}`}, ${bidx}, 'AUDIO',
                  ${JSON.stringify(body)}::jsonb, '{}'::jsonb, ${bidx}, 'RECEIVED', now(), ${seq})`,
    );
  });
}

describe("voice note to draft", () => {
  it("transcribes a voice note and creates a pending draft", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-1", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar"));

    const drafts = await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
      db.query<{ customer_name: string; amount_paise: string; status: string }>(
        sql`SELECT customer_name, amount_paise, status FROM app.entry_drafts WHERE shop_id = ${shop.shopId}`,
      ),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.customer_name).toBe("Ramesh");
    expect(drafts[0]!.amount_paise).toBe("30000");
    expect(drafts[0]!.status).toBe("PENDING");
    expect(await ledgerCount(shop.shopId)).toBe(0);
  });

  it("asks for clarification on an ambiguous transcript", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-2", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar, 50 wapas aaye"));

    const drafts = await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
      db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shop.shopId}`),
    );
    expect(drafts).toHaveLength(0);
    const replies = (await outboxRows(shop.shopId)).map((r) => r.payload.text ?? "");
    expect(replies.some((t) => t.length > 0)).toBe(true);
  });

  it("does not post a ledger entry directly from a voice note", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-3", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar"));
    expect(await ledgerCount(shop.shopId)).toBe(0);
  });

  it("replies politely when transcription fails", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-4", 2);
    const deps = inboundDeps(shop, "Ramesh 300 udhaar");
    (deps as unknown as { stt: unknown }).stt = {
      name: "failing",
      model: "failing",
      transcribe: async () => { throw new Error("stt down"); },
    };
    const result = await processNextInboxMessageForShop(shop.shopId, deps);
    expect(result.outcome).toBe("FAILED");
  });

  it("replies politely when no media id is present", async () => {
    const shop = await seedShop();
    // deliver an audio message without an id
    const { phoneBlindIndex } = await import("../../crypto/blindIndex");
    const bidx = phoneBlindIndex(shop.phone, env.PHONE_BLIND_INDEX_KEY);
    const id = (await import("node:crypto")).randomUUID();
    const body = { from: shop.phone, type: "audio", audio: {} };
    await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(
        sql`INSERT INTO app.inbox_messages (id, shop_id, wa_message_id, from_phone_bidx, message_type, body, raw_payload, body_hash, status, received_at, arrival_seq)
            VALUES (${id}, ${shop.shopId}, ${`w-${id.slice(0, 8)}`}, ${bidx}, 'AUDIO', ${JSON.stringify(body)}::jsonb, '{}'::jsonb, ${bidx}, 'RECEIVED', now(), 2)`,
      );
    });
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar"));
    const replies = (await outboxRows(shop.shopId)).map((r) => r.payload.text ?? "");
    expect(replies.some((t) => t.includes("could not process that voice note"))).toBe(true);
  });
});
