import { createHmac, randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { processNextInboxMessageForShop, type InboundDeps } from "../../whatsapp/inboundRouter";
import { deterministicParser } from "../../whatsapp/parser";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const store = new SimulatorStore();
const app = createApp({ webhook: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } });

function makeDeps(): InboundDeps {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging: new SimulatorMessagingProvider(store),
  };
}

const deps = makeDeps();

beforeEach(() => {
  store.reset();
});

function uniqueSellerPhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

interface SeedOptions {
  undoEdit?: boolean;
  undoAgeMs?: number;
  undoAmountPaise?: number;
}

async function seedShop(options: SeedOptions = {}): Promise<{ shopId: string; phone: string }> {
  const phone = uniqueSellerPhone();
  const shopId = randomUUID();
  const userId = randomUUID();
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const enc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, {
    shopId,
    table: "users",
    column: "phone_enc",
  });
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key)
          VALUES (${shopId}, 'Test shop', ${`t-${shopId.slice(0, 8)}`}, 'FLOWER_SELLER')`,
    );
    await db.execute(
      sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
          VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${enc}, ${bidx}, 1, 'ACTIVE')`,
    );
    await db.execute(
      sql`INSERT INTO app.shop_settings
            (shop_id, preset_key, language, undo_edit_enabled,
             undo_extra_confirm_age_ms, undo_extra_confirm_amount_paise)
          VALUES (${shopId}, 'FLOWER_SELLER', 'hi', ${options.undoEdit ?? false},
                  ${options.undoAgeMs ?? 86_400_000}, ${options.undoAmountPaise ?? 1_000_000})`,
    );
    await db.execute(
      sql`INSERT INTO app.consent_records (shop_id, user_id, purpose, granted, policy_version, method)
          VALUES (${shopId}, ${userId}, 'BOOKKEEPING', true, 'privacy-v3', 'WHATSAPP')`,
    );
  });
  return { shopId, phone };
}

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

async function deliverText(phone: string, text: string): Promise<void> {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  id: `wamid.${randomUUID()}`,
                  from: phone.replace(/^\+/, ""),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const response = await request(app)
    .post("/webhooks/whatsapp")
    .set("content-type", "application/json")
    .set("x-hub-signature-256", sign(raw))
    .send(raw);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function deliverTap(phone: string, interactiveId: string): Promise<void> {
  const payload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              messages: [
                {
                  id: `wamid.${randomUUID()}`,
                  from: phone.replace(/^\+/, ""),
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { id: interactiveId, title: "Tap" } },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const response = await request(app)
    .post("/webhooks/whatsapp")
    .set("content-type", "application/json")
    .set("x-hub-signature-256", sign(raw))
    .send(raw);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

type RunResult = Awaited<ReturnType<typeof processNextInboxMessageForShop>>;

async function sendText(
  shopId: string,
  phone: string,
  text: string,
  handler: InboundDeps = deps,
): Promise<RunResult> {
  await deliverText(phone, text);
  return processNextInboxMessageForShop(shopId, handler);
}

async function tap(
  shopId: string,
  phone: string,
  interactiveId: string,
  handler: InboundDeps = deps,
): Promise<RunResult> {
  await deliverTap(phone, interactiveId);
  return processNextInboxMessageForShop(shopId, handler);
}

interface DraftRow {
  id: string;
  customer_name: string;
  amount_paise: string;
  direction: string;
  is_credit_sale: boolean;
  type_unclear: boolean;
  status: string;
  confirmed_entry_id: string | null;
}

async function drafts(shopId: string): Promise<DraftRow[]> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<DraftRow>(
      sql`SELECT id, customer_name, amount_paise, direction, is_credit_sale, type_unclear, status,
                 confirmed_entry_id
            FROM app.entry_drafts WHERE shop_id = ${shopId} ORDER BY created_at, entry_index`,
    ),
  );
}

async function ledgerRows(
  shopId: string,
): Promise<Array<{ id: string; entry_type: string; amount_paise: string; reverses_entry_id: string | null }>> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ id: string; entry_type: string; amount_paise: string; reverses_entry_id: string | null }>(
      sql`SELECT id, entry_type, amount_paise, reverses_entry_id
            FROM app.ledger_entries WHERE shop_id = ${shopId} ORDER BY created_at`,
    ),
  );
}

async function balancePaise(shopId: string): Promise<number | null> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ balance_paise: string }>(
      sql`SELECT balance_paise FROM app.customers WHERE shop_id = ${shopId}`,
    ),
  );
  return rows[0] ? Number(rows[0].balance_paise) : null;
}

async function pendingEditCount(shopId: string): Promise<number> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM app.pending_edits
           WHERE shop_id = ${shopId} AND expires_at > now()`,
    ),
  );
  return Number(rows[0]?.count ?? "0");
}

function sentBodies(phone: string): string[] {
  return store.list({ to: phone }).map((message) => message.body);
}

async function createDraft(
  shopId: string,
  phone: string,
  text = "Ramesh 300 udhaar",
): Promise<DraftRow> {
  const result = await sendText(shopId, phone, text);
  expect(result.outcome, result.error).toBe("DONE");
  const rows = await drafts(shopId);
  const draft = rows[rows.length - 1];
  if (!draft) throw new Error("no draft was created");
  return draft;
}

async function confirmAndGetEntryId(shopId: string, phone: string): Promise<string> {
  const draft = await createDraft(shopId, phone);
  const result = await tap(shopId, phone, `confirm:${draft.id}`);
  expect(result.outcome, result.error).toBe("DONE");
  const after = (await drafts(shopId)).find((row) => row.id === draft.id);
  if (!after?.confirmed_entry_id) throw new Error("draft was not confirmed");
  return after.confirmed_entry_id;
}

async function beginAmountEdit(shopId: string, phone: string): Promise<DraftRow> {
  const draft = await createDraft(shopId, phone);
  expect((await tap(shopId, phone, `edit:${draft.id}`)).outcome).toBe("DONE");
  expect((await tap(shopId, phone, `edit_amount:${draft.id}`)).outcome).toBe("DONE");
  expect(await pendingEditCount(shopId)).toBe(1);
  return draft;
}

describe("ledger is only written by an explicit seller tap", () => {
  it("ledger not posted before tap: a parsed message creates a draft and zero ledger rows", async () => {
    const { shopId, phone } = await seedShop();
    await createDraft(shopId, phone);

    expect(await ledgerRows(shopId)).toHaveLength(0);
    expect(await balancePaise(shopId)).toBe(0);

    const draft = (await drafts(shopId))[0]!;
    expect((await tap(shopId, phone, `confirm:${draft.id}`)).outcome).toBe("DONE");

    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect(await balancePaise(shopId)).toBe(30000);
  });
});

describe("undo through the real handler", () => {
  it("undo normal: tapping Undo appends exactly one reversal and restores the balance", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const entryId = await confirmAndGetEntryId(shopId, phone);
    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect(await balancePaise(shopId)).toBe(30000);

    expect((await sendText(shopId, phone, "undo")).outcome).toBe("DONE");
    expect(sentBodies(phone).some((body) => body.includes("Tap to confirm"))).toBe(true);
    expect(await ledgerRows(shopId)).toHaveLength(1);

    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    const rows = await ledgerRows(shopId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.entry_type).toBe("REVERSAL");
    expect(rows[1]?.amount_paise).toBe("30000");
    expect(rows[1]?.reverses_entry_id).toBe(entryId);
    expect(await balancePaise(shopId)).toBe(0);
  });

  it("undo old-entry: an entry older than the shop threshold needs a second confirmation", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const entryId = await confirmAndGetEntryId(shopId, phone);
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(
        sql`UPDATE app.entry_drafts SET confirmed_at = now() - interval '2 days'
             WHERE shop_id = ${shopId} AND confirmed_entry_id = ${entryId}`,
      );
    });

    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect(sentBodies(phone).some((body) => body.includes("Confirm undo"))).toBe(true);

    expect((await tap(shopId, phone, `undo_final:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(2);
  });

  it("undo large-entry: an amount above the shop threshold needs a second confirmation", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true, undoAmountPaise: 10_000 });
    const entryId = await confirmAndGetEntryId(shopId, phone);

    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect(sentBodies(phone).some((body) => body.includes("Confirm undo"))).toBe(true);

    expect((await tap(shopId, phone, `undo_final:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(2);
  });

  it("undo already reversed: the second undo is refused politely and writes no row", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const entryId = await confirmAndGetEntryId(shopId, phone);

    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(2);

    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(2);
    expect(sentBodies(phone).some((body) => body.includes("already undone"))).toBe(true);
  });

  it("undo stale entry id: an unknown id is refused politely and posts nothing", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const result = await tap(shopId, phone, `undo_confirm:${randomUUID()}`);

    expect(result.outcome).toBe("DONE");
    expect(await ledgerRows(shopId)).toHaveLength(0);
    expect(sentBodies(phone).some((body) => body.includes("could not find that entry"))).toBe(true);
  });

  it("undo foreign entry id: another shop's entry is refused and both ledgers are unchanged", async () => {
    const shopA = await seedShop({ undoEdit: true });
    const shopB = await seedShop({ undoEdit: true });
    const entryA = await confirmAndGetEntryId(shopA.shopId, shopA.phone);

    const result = await tap(shopB.shopId, shopB.phone, `undo_confirm:${entryA}`);

    expect(result.outcome).toBe("DONE");
    expect(await ledgerRows(shopA.shopId)).toHaveLength(1);
    expect(await ledgerRows(shopB.shopId)).toHaveLength(0);
    expect(sentBodies(shopB.phone).some((body) => body.includes("could not find that entry"))).toBe(true);
  });
});

describe("edit through the real handler", () => {
  it("edit amount: a valid reply replaces the draft amount in paise", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, "500")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("50000");
    expect(await pendingEditCount(shopId)).toBe(0);
  });

  it("edit name: the reply replaces the draft customer name", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await createDraft(shopId, phone);
    await tap(shopId, phone, `edit:${draft.id}`);
    await tap(shopId, phone, `edit_name:${draft.id}`);

    expect((await sendText(shopId, phone, "Suresh")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.customer_name).toBe("Suresh");
    expect(await pendingEditCount(shopId)).toBe(0);
  });

  it("edit type: cash clears type_unclear and sets is_credit_sale to false", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await createDraft(shopId, phone);
    expect(draft.is_credit_sale).toBe(true);
    await tap(shopId, phone, `edit:${draft.id}`);
    await tap(shopId, phone, `edit_type:${draft.id}`);

    expect((await sendText(shopId, phone, "cash")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.is_credit_sale).toBe(false);
    expect(after?.type_unclear).toBe(false);
    expect(after?.direction).toBe("CREDIT");
    expect(await pendingEditCount(shopId)).toBe(0);
  });

  it("edit invalid amount abc: refused, draft unchanged, edit stays open", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, "abc")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("30000");
    expect(await pendingEditCount(shopId)).toBe(1);
    expect(sentBodies(phone).some((body) => body.includes("doesn't look right"))).toBe(true);
  });

  it("edit invalid amount negative: refused, draft unchanged, edit stays open", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, "-5")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("30000");
    expect(await pendingEditCount(shopId)).toBe(1);
  });

  it("edit invalid amount zero: refused, draft unchanged, edit stays open", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, "0")).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("30000");
    expect(await pendingEditCount(shopId)).toBe(1);
  });

  it("edit invalid amount above ceiling: refused, draft unchanged, edit stays open", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, String(env.MAX_ENTRY_PAISE / 100))).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("30000");
    expect(await pendingEditCount(shopId)).toBe(1);
  });

  it("edit after confirm: refused politely and the confirmed draft is unchanged", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const entryId = await confirmAndGetEntryId(shopId, phone);
    const draft = (await drafts(shopId))[0]!;

    const result = await tap(shopId, phone, `edit:${draft.id}`);

    expect(result.outcome).toBe("DONE");
    expect(await pendingEditCount(shopId)).toBe(0);
    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect((await drafts(shopId))[0]?.status).toBe("CONFIRMED");
    expect((await drafts(shopId))[0]?.confirmed_entry_id).toBe(entryId);
    expect(sentBodies(phone).some((body) => body.includes("already confirmed"))).toBe(true);
  });

  it("edit double tap: tapping the amount option twice keeps exactly one pending edit", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await createDraft(shopId, phone);
    await tap(shopId, phone, `edit:${draft.id}`);
    await tap(shopId, phone, `edit_amount:${draft.id}`);
    await tap(shopId, phone, `edit_amount:${draft.id}`);

    expect(await pendingEditCount(shopId)).toBe(1);

    expect((await sendText(shopId, phone, "500")).outcome).toBe("DONE");
    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("50000");
    expect(await pendingEditCount(shopId)).toBe(0);
  });

  it("edit another shop's draft: refused, no pending edit, the draft is unchanged", async () => {
    const shopA = await seedShop({ undoEdit: true });
    const shopB = await seedShop({ undoEdit: true });
    const draftA = await createDraft(shopA.shopId, shopA.phone);

    const result = await tap(shopB.shopId, shopB.phone, `edit_amount:${draftA.id}`);

    expect(result.outcome).toBe("DONE");
    expect(await pendingEditCount(shopB.shopId)).toBe(0);
    expect(await pendingEditCount(shopA.shopId)).toBe(0);
    const after = (await drafts(shopA.shopId)).find((row) => row.id === draftA.id);
    expect(after?.amount_paise).toBe("30000");
    expect(sentBodies(shopB.phone).some((body) => body.includes("could not find that entry"))).toBe(true);
  });
});

describe("pending edit state lives in the database", () => {
  it("pending edit expiry: an expired row is ignored and does not touch the draft", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);
    await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
      await db.execute(
        sql`UPDATE app.pending_edits SET expires_at = now() - interval '1 minute'
             WHERE shop_id = ${shopId}`,
      );
    });

    const result = await sendText(shopId, phone, "500");

    // The expired row is ignored: the bare amount is no longer an edit value, so it is
    // treated as an incomplete new entry and the draft is untouched.
    expect(result.outcome).toBe("DONE");
    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("30000");
    expect(sentBodies(phone).some((body) => body.includes("missing_customer"))).toBe(true);
  });

  it("pending edit survives a restart: a new handler instance reads the row from PostgreSQL", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    const restarted = makeDeps();
    expect((await sendText(shopId, phone, "500", restarted)).outcome).toBe("DONE");

    const after = (await drafts(shopId)).find((row) => row.id === draft.id);
    expect(after?.amount_paise).toBe("50000");
    expect(await pendingEditCount(shopId)).toBe(0);
  });

  it("new entry while editing: asked once, then the repeat is taken as a new entry", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: true });
    const draft = await beginAmountEdit(shopId, phone);

    expect((await sendText(shopId, phone, "Suresh 400 udhaar")).outcome).toBe("DONE");
    expect(await drafts(shopId)).toHaveLength(1);
    expect(await pendingEditCount(shopId)).toBe(0);
    expect(sentBodies(phone).some((body) => body.includes("or a new entry"))).toBe(true);

    expect((await sendText(shopId, phone, "Suresh 400 udhaar")).outcome).toBe("DONE");
    const rows = await drafts(shopId);
    expect(rows).toHaveLength(2);
    const original = rows.find((row) => row.id === draft.id);
    expect(original?.amount_paise).toBe("30000");
  });
});

describe("undo/edit feature flag", () => {
  it("feature flag off: undo and edit commands are refused politely and write nothing", async () => {
    const { shopId, phone } = await seedShop({ undoEdit: false });
    const entryId = await confirmAndGetEntryId(shopId, phone);
    expect(await ledgerRows(shopId)).toHaveLength(1);

    expect((await sendText(shopId, phone, "undo")).outcome).toBe("DONE");
    expect((await tap(shopId, phone, `undo_confirm:${entryId}`)).outcome).toBe("DONE");
    expect((await sendText(shopId, phone, "edit 123")).outcome).toBe("DONE");

    expect(await ledgerRows(shopId)).toHaveLength(1);
    expect(sentBodies(phone).filter((body) => body.includes("not enabled")).length).toBe(3);
  });
});
