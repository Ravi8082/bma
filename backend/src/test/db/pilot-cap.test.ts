import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { deterministicParser, type EntryParser } from "../../whatsapp/parser";
import {
  getPilotSpend,
  PILOT_CAP_MESSAGE,
  pilotCapBreach,
  pilotCapsFor,
  utcDayStart,
  utcMonthStart,
} from "../../whatsapp/pilotBudget";
import { deliverText, seedShop, type SeededShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

/** An LLM parser that counts calls and then delegates the actual parse. */
function countingParser(): { parser: EntryParser; calls: () => number } {
  let calls = 0;
  return {
    parser: {
      name: "counting-llm",
      parse: (text, options) => deterministicParser.parse(text, options),
      async parseAsync(text, options) {
        calls += 1;
        return deterministicParser.parse(text, options);
      },
    },
    calls: () => calls,
  };
}

async function recordSpend(shopId: string, costPaise: number, occurredAt: Date = new Date()): Promise<void> {
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.cost_log (shop_id, provider, model, kind, outcome, cost_paise, occurred_at)
          VALUES (${shopId}, 'test', 'test-model', 'LLM', 'SUCCESS', ${costPaise}, ${occurredAt})`,
    );
  });
}

async function draftCount(shopId: string): Promise<number> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    const row = await db.queryOne<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM app.entry_drafts WHERE shop_id = ${shopId}`,
    );
    return Number.parseInt(row?.c ?? "0", 10);
  });
}

async function capNoticeCount(shopId: string): Promise<number> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    const row = await db.queryOne<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM app.outbox_events
           WHERE shop_id = ${shopId} AND payload->>'text' = ${PILOT_CAP_MESSAGE}`,
    );
    return Number.parseInt(row?.c ?? "0", 10);
  });
}

function deps(parser: EntryParser, shop: SeededShop) {
  return {
    parser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging: shop.messaging,
  };
}

describe("free-pilot cost caps", () => {
  it("uses the AI parser while the shop is below both caps", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 10_000, pilotMonthlyCapPaise: 100_000 });
    await recordSpend(shop.shopId, 2_000);
    const spy = countingParser();

    await deliverText(shop.shopId, shop.phone, "Ramesh 300 udhaar", 2);
    await processNextInboxMessageForShop(shop.shopId, deps(spy.parser, shop));

    expect(spy.calls()).toBe(1);
    expect(await draftCount(shop.shopId)).toBe(1);
    expect(await capNoticeCount(shop.shopId)).toBe(0);
  });

  it("switches to the deterministic parser at the daily cap, keeps the entry and sends one notice", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 1_000, pilotMonthlyCapPaise: 100_000 });
    await recordSpend(shop.shopId, 1_500);
    const spy = countingParser();

    await deliverText(shop.shopId, shop.phone, "Ramesh 300 udhaar", 2);
    await processNextInboxMessageForShop(shop.shopId, deps(spy.parser, shop));

    // The cap never drops an entry; it only downgrades the parser.
    expect(await draftCount(shop.shopId)).toBe(1);
    expect(spy.calls()).toBe(0);
    expect(await capNoticeCount(shop.shopId)).toBe(1);
  });

  it("tells the seller once per period, not once per message", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 1_000, pilotMonthlyCapPaise: 100_000 });
    await recordSpend(shop.shopId, 5_000);
    const spy = countingParser();

    await deliverText(shop.shopId, shop.phone, "Ramesh 300 udhaar", 2);
    await processNextInboxMessageForShop(shop.shopId, deps(spy.parser, shop));
    await deliverText(shop.shopId, shop.phone, "Sita 200 udhaar", 3);
    await processNextInboxMessageForShop(shop.shopId, deps(spy.parser, shop));

    expect(await draftCount(shop.shopId)).toBe(2);
    expect(spy.calls()).toBe(0);
    expect(await capNoticeCount(shop.shopId)).toBe(1);
  });

  it("switches at the monthly cap even when today is below the daily cap", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 1_000_000, pilotMonthlyCapPaise: 5_000 });
    await recordSpend(shop.shopId, 6_000, utcMonthStart(new Date()));
    const spy = countingParser();

    await deliverText(shop.shopId, shop.phone, "Ramesh 300 udhaar", 2);
    await processNextInboxMessageForShop(shop.shopId, deps(spy.parser, shop));

    expect(spy.calls()).toBe(0);
    expect(await draftCount(shop.shopId)).toBe(1);
    expect(await capNoticeCount(shop.shopId)).toBe(1);
  });

  it("honours a per-shop cap instead of the platform default", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 1_000, pilotMonthlyCapPaise: 50_000 });
    // Above the shop override, below the env default, so only the override can trip.
    await recordSpend(shop.shopId, 1_500);
    expect(env.PILOT_DAILY_CAP_PAISE).toBeGreaterThan(1_500);

    const caps = await pilotCapsFor(shop.shopId);
    expect(caps).toEqual({ dailyPaise: 1_000, monthlyPaise: 50_000 });
    expect(pilotCapBreach(await getPilotSpend(shop.shopId), caps)?.cap).toBe("DAY");
  });

  it("reads today's spend separately from this month's spend", async () => {
    const shop = await seedShop();
    const now = new Date(Date.UTC(2026, 10, 17, 12, 0, 0));
    await recordSpend(shop.shopId, 700, utcMonthStart(now));
    await recordSpend(shop.shopId, 300, utcDayStart(now));

    const spend = await getPilotSpend(shop.shopId, now);
    expect(spend.dayPaise).toBe(300);
    expect(spend.monthPaise).toBe(1_000);
  });
});
