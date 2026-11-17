import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { confirmDraft } from "../../whatsapp/confirmation";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { StubSttProvider } from "../../integrations/speech/stub";
import { ledgerCount, seedShop } from "../helpers/seed";
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

async function draftIdFor(shopId: string): Promise<string> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ id: string }>(sql`SELECT id FROM app.entry_drafts WHERE shop_id = ${shopId} ORDER BY created_at DESC LIMIT 1`),
  );
  return rows[0]!.id;
}

describe("voice draft confirmation and cost", () => {
  it("confirms a voice-created draft exactly once and records STT cost", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-c", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar"));

    expect(await ledgerCount(shop.shopId)).toBe(0);
    const draftId = await draftIdFor(shop.shopId);

    const result = await confirmDraft(shop.shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(result.status).toBe("CONFIRMED");
    expect(await ledgerCount(shop.shopId)).toBe(1);

    const repeat = await confirmDraft(shop.shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(repeat.status).toBe("ALREADY_CONFIRMED");
    expect(await ledgerCount(shop.shopId)).toBe(1);

    // cost_log should have an STT row
    const costs = await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
      db.query<{ kind: string; cost_paise: string }>(sql`SELECT kind, cost_paise::text FROM app.cost_log WHERE shop_id = ${shop.shopId}`),
    );
    expect(costs.some((c) => c.kind === "STT")).toBe(true);
  });

  it("records no STT cost when transcription fails", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-f", 2);
    const deps = inboundDeps(shop, "Ramesh 300 udhaar");
    (deps as unknown as { stt: unknown }).stt = {
      name: "failing",
      model: "failing",
      transcribe: async () => { throw new Error("stt down"); },
    };
    const result = await processNextInboxMessageForShop(shop.shopId, deps);
    expect(result.outcome).toBe("FAILED");
    const costs = await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
      db.query<{ id: string }>(sql`SELECT id FROM app.cost_log WHERE shop_id = ${shop.shopId}`),
    );
    expect(costs).toHaveLength(0);
  });

  it("cancels a voice-created draft without posting", async () => {
    const shop = await seedShop();
    await deliverAudio(shop.shopId, shop.phone, "media-x", 2);
    await processNextInboxMessageForShop(shop.shopId, inboundDeps(shop, "Ramesh 300 udhaar"));
    const draftId = await draftIdFor(shop.shopId);
    const { cancelDraft } = await import("../../whatsapp/confirmation");
    const r = await cancelDraft(shop.shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF });
    expect(r.status).toBe("CANCELLED");
    expect(await ledgerCount(shop.shopId)).toBe(0);
  });
});
