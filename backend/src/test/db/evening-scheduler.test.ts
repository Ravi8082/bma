import { randomInt, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { encryptField } from "../../crypto/fieldEncryption";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { processNextInboxMessageForShop, type InboundDeps } from "../../whatsapp/inboundRouter";
import { runEveningTick, type EveningDeps } from "../../whatsapp/eveningScheduler";
import { processNextOutboundForShop } from "../../whatsapp/outboundSender";
import { deterministicParser } from "../../whatsapp/parser";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const store = new SimulatorStore();
const messaging = new SimulatorMessagingProvider(store);

const eveningDeps: EveningDeps = { keyRef: env.FIELD_ENCRYPTION_KEY_REF };

function inboxDeps(): InboundDeps {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging,
  };
}

beforeEach(() => {
  store.reset();
});

function uniquePhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

interface SeedOptions {
  timeZone?: string;
  eveningTime?: string;
  drafts?: number;
  templateSet?: string | null;
  receivedAtSql?: "now" | "25 hours ago";
}

interface SeededShop {
  shopId: string;
  phone: string;
  bidx: Buffer;
}

async function seedShop(options: SeedOptions = {}): Promise<SeededShop> {
  const shopId = randomUUID();
  const phone = uniquePhone();
  const userId = randomUUID();
  const msgId = randomUUID();
  const timeZone = options.timeZone ?? "Asia/Kolkata";
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const userEnc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, {
    shopId,
    table: "users",
    column: "phone_enc",
  });
  const draftEnc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, {
    shopId,
    table: "entry_drafts",
    column: "seller_phone_enc",
  });
  const drafts = options.drafts ?? 0;

  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key, timezone)
          VALUES (${shopId}, 'Evening shop', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER', ${timeZone})`,
    );
    await db.execute(
      sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
          VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${userEnc}, ${bidx}, 1, 'ACTIVE')`,
    );
    await db.execute(
      sql`INSERT INTO app.shop_settings
            (shop_id, preset_key, language, timezone, evening_summary_time, template_set)
          VALUES (${shopId}, 'FLOWER_SELLER', 'hi', ${timeZone},
                  ${options.eveningTime ?? "18:30"}, ${options.templateSet ?? null})`,
    );
    await db.execute(
      sql`INSERT INTO app.inbox_messages
            (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash,
             status, received_at, arrival_seq)
          VALUES (${msgId}, ${shopId}, ${`w-${msgId.slice(0, 8)}`}, ${bidx}, 'TEXT', '{}'::jsonb,
                  ${bidx}, 'DONE', now(), 1)`,
    );
    if (options.receivedAtSql === "25 hours ago") {
      await db.execute(
        sql`UPDATE app.inbox_messages SET received_at = now() - interval '25 hours' WHERE id = ${msgId}`,
      );
    }
    for (let index = 0; index < drafts; index += 1) {
      const id = randomUUID();
      await db.execute(
        sql`INSERT INTO app.entry_drafts
              (id, shop_id, source_message_id, wa_message_id, customer_name, entry_type, direction,
               amount_paise, is_credit_sale, type_unclear, raw_text, source_tag, status,
               seller_phone_enc, seller_phone_bidx, key_version, entry_index)
            VALUES (${id}, ${shopId}, ${msgId}, ${`w-${msgId.slice(0, 8)}`}, ${`C${index}`}, 'SALE',
                    'DEBIT', 10000, true, false, 'msg', 'SELLER', 'PENDING', ${draftEnc}, ${bidx}, 1, ${index})`,
      );
    }
  });

  return { shopId, phone, bidx };
}

interface RunRow {
  shop_id: string;
  run_date: string;
  batch_id: string | null;
}

async function runRows(shopId: string): Promise<RunRow[]> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<RunRow>(
      sql`SELECT shop_id, run_date::text AS run_date, batch_id FROM app.evening_runs
           WHERE shop_id = ${shopId} ORDER BY run_date`,
    ),
  );
}

async function outboxRows(
  shopId: string,
): Promise<Array<{ id: string; state: string; payload: { text?: string; body?: string } }>> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ id: string; state: string; payload: { text?: string; body?: string } }>(
      sql`SELECT id, state, payload FROM app.outbox_events
           WHERE shop_id = ${shopId} ORDER BY queued_at`,
    ),
  );
}

async function batchIds(shopId: string): Promise<string[]> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    const rows = await db.query<{ batch_id: string | null }>(
      sql`SELECT DISTINCT batch_id FROM app.entry_drafts WHERE shop_id = ${shopId}`,
    );
    return rows.map((row) => row.batch_id).filter((value): value is string => value !== null);
  });
}

async function deliverInbox(shopId: string, phone: string, text: string, seq: number): Promise<void> {
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const id = randomUUID();
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.inbox_messages
            (id, shop_id, wa_message_id, from_phone_bidx, message_type, body, raw_payload, body_hash,
             status, received_at, arrival_seq)
          VALUES (${id}, ${shopId}, ${`w-${id.slice(0, 8)}`}, ${bidx}, 'TEXT',
                  ${JSON.stringify({ from: phone, text: { body: text } })}::jsonb, '{}'::jsonb,
                  ${bidx}, 'RECEIVED', now(), ${seq})`,
    );
  });
}

async function drainOutbound(shopId: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    const result = await processNextOutboundForShop(shopId, {
      messaging,
      keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    });
    if (result.state === "EMPTY") return;
  }
}

describe("evening scheduler", () => {
  it("fires at the configured local evening time, not one minute early", async () => {
    const { shopId } = await seedShop({ drafts: 2 });

    const early = await runEveningTick(eveningDeps, new Date("2026-06-15T12:59:00Z"), [shopId]);
    expect(early.ranShops).toBe(0);
    expect(early.dueShops).toBe(0);
    expect(await runRows(shopId)).toHaveLength(0);
    expect(await outboxRows(shopId)).toHaveLength(0);

    // 13:00Z is 18:30 in Asia/Kolkata (UTC+5:30).
    const due = await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [shopId]);
    expect(due.ranShops).toBe(1);
    const rows = await runRows(shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_date).toBe("2026-06-15");
    expect(rows[0]!.batch_id).not.toBeNull();
    expect(await batchIds(shopId)).toEqual([rows[0]!.batch_id]);

    const outbox = await outboxRows(shopId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload.text).toContain("2 entries");
    expect(outbox[0]!.payload.text).toContain("200");
  });

  it("uses each shop's own timezone, not the platform's clock", async () => {
    // 13:00Z is 18:30 in Kolkata but 09:00 in New York.
    const kolkata = await seedShop({ timeZone: "Asia/Kolkata", drafts: 1 });
    const newYork = await seedShop({ timeZone: "America/New_York", drafts: 1 });

    const first = await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [
      kolkata.shopId,
      newYork.shopId,
    ]);
    expect(first.ranShops).toBe(1);
    expect(await runRows(kolkata.shopId)).toHaveLength(1);
    expect(await runRows(newYork.shopId)).toHaveLength(0);

    // 22:30Z is 18:30 in New York (EDT, UTC-4).
    const second = await runEveningTick(eveningDeps, new Date("2026-06-15T22:30:00Z"), [
      kolkata.shopId,
      newYork.shopId,
    ]);
    expect(second.ranShops).toBe(1);
    const nyRows = await runRows(newYork.shopId);
    expect(nyRows).toHaveLength(1);
    expect(nyRows[0]!.run_date).toBe("2026-06-15");
    // Kolkata is already past midnight on the 16th, so the 15th is not re-run.
    expect(await runRows(kolkata.shopId)).toHaveLength(1);
  });

  it("does not fire after local midnight on the next day", async () => {
    const yesterdays = await seedShop({ drafts: 1 });
    const fresh = await seedShop({ drafts: 1 });

    const evening = await runEveningTick(eveningDeps, new Date("2026-06-15T13:01:00Z"), [
      yesterdays.shopId,
    ]);
    expect(evening.ranShops).toBe(1);
    expect((await runRows(yesterdays.shopId))[0]!.run_date).toBe("2026-06-15");

    // 18:35Z is 00:05 on 16 June in Asia/Kolkata: before the configured evening time.
    const afterMidnight = await runEveningTick(eveningDeps, new Date("2026-06-15T18:35:00Z"), [
      yesterdays.shopId,
      fresh.shopId,
    ]);
    expect(afterMidnight.ranShops).toBe(0);
    expect(afterMidnight.dueShops).toBe(0);
    expect(await runRows(fresh.shopId)).toHaveLength(0);
    expect(await outboxRows(fresh.shopId)).toHaveLength(0);
    expect(await runRows(yesterdays.shopId)).toHaveLength(1);
  });

  it("sends exactly one summary when two instances tick concurrently", async () => {
    const { shopId, phone } = await seedShop({ drafts: 2 });
    const now = new Date("2026-06-15T13:00:00Z");

    const [a, b] = await Promise.all([
      runEveningTick(eveningDeps, now, [shopId]),
      runEveningTick(eveningDeps, now, [shopId]),
    ]);
    expect(a.ranShops + b.ranShops).toBe(1);
    expect(a.skippedShops + b.skippedShops).toBe(1);
    expect(await runRows(shopId)).toHaveLength(1);
    expect(await outboxRows(shopId)).toHaveLength(1);

    await drainOutbound(shopId);
    const sent = store.list({ to: phone });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain("Evening summary: 2 entries");
    expect((await outboxRows(shopId))[0]!.state).toBe("SENT");
  });

  it("does not send again when the process restarts later the same day", async () => {
    const { shopId, phone } = await seedShop({ drafts: 3 });

    await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [shopId]);
    await drainOutbound(shopId);
    expect(store.list({ to: phone })).toHaveLength(1);
    const batchBefore = (await runRows(shopId))[0]!.batch_id;

    // Restart at 20:00 local: the day is already claimed.
    const restart = await runEveningTick(eveningDeps, new Date("2026-06-15T14:30:00Z"), [shopId]);
    expect(restart.ranShops).toBe(0);
    expect(restart.skippedShops).toBe(1);
    expect(await runRows(shopId)).toHaveLength(1);
    expect((await runRows(shopId))[0]!.batch_id).toBe(batchBefore);
    expect(await outboxRows(shopId)).toHaveLength(1);
    expect(store.list({ to: phone })).toHaveLength(1);
  });

  it("sends nothing for a shop with no pending drafts but still records the day", async () => {
    const { shopId, phone } = await seedShop({ drafts: 0 });

    const result = await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [shopId]);
    expect(result.ranShops).toBe(0);
    expect(result.emptyShops).toBe(1);

    const rows = await runRows(shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.batch_id).toBeNull();
    expect(await outboxRows(shopId)).toHaveLength(0);

    await drainOutbound(shopId);
    expect(store.list({ to: phone })).toHaveLength(0);
  });

  it("uses the approved template when the 24-hour window is closed", async () => {
    const { shopId, phone } = await seedShop({
      drafts: 2,
      templateSet: "evening_summary_v1",
      receivedAtSql: "25 hours ago",
    });

    await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [shopId]);
    await drainOutbound(shopId);

    const sent = store.list({ to: phone });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe("TEMPLATE");
    expect(sent[0]!.templateName).toBe("evening_summary_v1");
    expect(sent[0]!.body).toContain("Evening summary: 2 entries");
    expect((await outboxRows(shopId))[0]!.state).toBe("SENT");
  });

  it("keeps the summary queued when the window is closed and there is no template", async () => {
    const { shopId, phone } = await seedShop({
      drafts: 2,
      templateSet: null,
      receivedAtSql: "25 hours ago",
    });

    await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"), [shopId]);
    await drainOutbound(shopId);

    expect(store.list({ to: phone })).toHaveLength(0);
    const rows = await outboxRows(shopId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("QUEUED");
  });

  it("discovers due shops from the platform inbox without a tenant context", async () => {
    const { shopId } = await seedShop({ drafts: 1 });

    // No shop filter: the scheduler fans out exactly like production does.
    const result = await runEveningTick(eveningDeps, new Date("2026-06-15T13:00:00Z"));
    expect(result.dueShops).toBeGreaterThanOrEqual(1);
    expect(await runRows(shopId)).toHaveLength(1);
    expect(await outboxRows(shopId)).toHaveLength(1);
  });

  it("sends today's summary on demand for summary and hisaab", async () => {
    const { shopId, phone } = await seedShop({ drafts: 0, eveningTime: "23:59" });
    const deps = inboxDeps();

    await deliverInbox(shopId, phone, "summary", 1);
    const empty = await processNextInboxMessageForShop(shopId, deps);
    expect(empty.outcome, empty.error).toBe("DONE");
    expect(store.list({ to: phone }).map((message) => message.body)).toContain(
      "No pending entries today.",
    );

    await deliverInbox(shopId, phone, "Ramesh 300 udhaar", 2);
    const created = await processNextInboxMessageForShop(shopId, deps);
    expect(created.outcome, created.error).toBe("DONE");

    await deliverInbox(shopId, phone, "hisaab", 3);
    const onDemand = await processNextInboxMessageForShop(shopId, deps);
    expect(onDemand.outcome, onDemand.error).toBe("DONE");

    const bodies = store.list({ to: phone }).map((message) => message.body);
    const summary = bodies.find((body) => body.includes("Evening summary:"));
    expect(summary).toBeDefined();
    expect(summary).toContain("1 entry");
    expect(summary).toContain("300");

    const rows = await outboxRows(shopId);
    const summaryRow = rows.find((row) => (row.payload.text ?? "").includes("Evening summary:"));
    expect(summaryRow).toBeDefined();
    expect(summaryRow!.state).toBe("SENT");
    expect(await batchIds(shopId)).toHaveLength(1);

    // On-demand summaries are independent of the undo/edit flag.
    const settings = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
      db.query<{ undo_edit_enabled: boolean }>(
        sql`SELECT undo_edit_enabled FROM app.shop_settings WHERE shop_id = ${shopId}`,
      ),
    );
    expect(settings[0]!.undo_edit_enabled).toBe(false);
  });
});
