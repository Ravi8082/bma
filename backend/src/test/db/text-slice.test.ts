import { createHmac, randomInt, randomUUID } from "node:crypto";
import { Client } from "pg";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { connectDb, getPool, withTransaction } from "../../config/db";
import { queryWithoutTenant, withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { claimNextForShop, reclaimExpiredLeases } from "../../whatsapp/inbox";
import { processNextInboxMessageForShop } from "../../whatsapp/inboundRouter";
import { processNextOutboundForShop } from "../../whatsapp/outboundSender";
import { deterministicParser } from "../../whatsapp/parser";
import {
  confirmDraft,
  EntryAlreadyReversedError,
  reverseLedgerEntry,
} from "../../whatsapp/confirmation";
import type { WebhookTransactionRunner } from "../../whatsapp/webhookController";
import {
  readTestBootstrapUrl,
  readTestDatabaseUrl,
  usePostgres,
} from "../helpers/postgres";

usePostgres();

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "test-verify-token";
const store = new SimulatorStore();
const deps = {
  parser: deterministicParser,
  keyRef: env.FIELD_ENCRYPTION_KEY_REF,
  blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
  messaging: new SimulatorMessagingProvider(store),
};
const app = createApp({ webhook: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } });

beforeEach(() => {
  store.reset();
});

function uniqueSellerPhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

async function seedSeller(phone: string): Promise<{ shopId: string; userId: string }> {
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
  });
  return { shopId, userId };
}

interface InboundInput {
  waId: string;
  from: string;
  type?: string;
  text?: string;
  interactiveId?: string;
}

function buildPayload(input: InboundInput): unknown {
  const message: Record<string, unknown> = {
    id: input.waId,
    from: input.from.replace(/^\+/, ""),
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: input.type ?? "text",
  };
  if (input.text !== undefined) message.text = { body: input.text };
  if (input.interactiveId !== undefined) {
    message.interactive = {
      type: "button_reply",
      button_reply: { id: input.interactiveId, title: "Confirm" },
    };
  }
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "1",
        changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [message] } }],
      },
    ],
  };
}

function sign(raw: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
}

async function postWebhook(payload: unknown, signature?: string) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post("/webhooks/whatsapp")
    .set("content-type", "application/json")
    .set("x-hub-signature-256", signature ?? sign(raw))
    .send(raw);
}

async function inboxCount(shopId: string, waId: string): Promise<number> {
  const rows = await queryWithoutTenant<{ count: string }>(
    sql`SELECT COUNT(*) AS count FROM app.inbox_messages
         WHERE shop_id = ${shopId} AND wa_message_id = ${waId}`,
  );
  return Number(rows[0]?.count ?? "0");
}

async function inboxRow(
  shopId: string,
  waId: string,
): Promise<{ id: string; status: string; attempt_count: number } | null> {
  const rows = await queryWithoutTenant<{ id: string; status: string; attempt_count: number }>(
    sql`SELECT id, status, attempt_count FROM app.inbox_messages
         WHERE shop_id = ${shopId} AND wa_message_id = ${waId}`,
  );
  return rows[0] ?? null;
}

interface DraftRow {
  id: string;
  customer_name: string;
  amount_paise: string;
  direction: string;
  entry_type: string;
  is_credit_sale: boolean;
  status: string;
  confirmed_entry_id: string | null;
}

async function drafts(shopId: string): Promise<DraftRow[]> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<DraftRow>(
      sql`SELECT id, customer_name, amount_paise, direction, entry_type, is_credit_sale,
                 status, confirmed_entry_id
            FROM app.entry_drafts WHERE shop_id = ${shopId} ORDER BY created_at`,
    ),
  );
}

async function ledger(
  shopId: string,
): Promise<
  Array<{
    amount_paise: string;
    direction: string;
    entry_type: string;
    source: string;
    idempotency_key: string;
  }>
> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{
      amount_paise: string;
      direction: string;
      entry_type: string;
      source: string;
      idempotency_key: string;
    }>(
      sql`SELECT amount_paise, direction, entry_type, source, idempotency_key
            FROM app.ledger_entries WHERE shop_id = ${shopId} ORDER BY created_at`,
    ),
  );
}

async function customerBalance(shopId: string): Promise<number | null> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ balance_paise: string }>(
      sql`SELECT balance_paise FROM app.customers WHERE shop_id = ${shopId}`,
    ),
  );
  return rows[0] ? Number(rows[0].balance_paise) : null;
}

async function expireFailedLeases(shopId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `UPDATE app.inbox_messages
          SET lease_until = now() - interval '1 second'
        WHERE shop_id = $1 AND status = 'FAILED'`,
      [shopId],
    );
  } finally {
    client.release();
  }
}

async function expireLease(messageId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query(
      `UPDATE app.inbox_messages
          SET lease_until = now() - interval '1 second'
        WHERE id = $1`,
      [messageId],
    );
  } finally {
    client.release();
  }
}

/** Wait until a transaction is actually blocked on a PostgreSQL advisory lock. */
async function waitForAdvisoryWait(timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await queryWithoutTenant<{ count: string }>(
      sql`SELECT COUNT(*) AS count
            FROM pg_stat_activity
           WHERE application_name = 'bma-api'
             AND wait_event_type = 'Lock'
             AND wait_event = 'advisory'`,
    );
    if (Number(rows[0]?.count ?? "0") > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function inboxRows(
  shopId: string,
): Promise<Array<{ id: string; wa_message_id: string; arrival_seq: string }>> {
  return queryWithoutTenant<{ id: string; wa_message_id: string; arrival_seq: string }>(
    sql`SELECT id, wa_message_id, arrival_seq
          FROM app.inbox_messages
         WHERE shop_id = ${shopId}
         ORDER BY arrival_seq`,
  );
}

interface FullLedgerRow {
  id: string;
  shop_id: string;
  customer_id: string | null;
  posting_id: string;
  entry_seq: number;
  entry_type: string;
  direction: string;
  amount_paise: string;
  currency: string;
  occurred_at: Date;
  description: string | null;
  source: string;
  source_id: string | null;
  idempotency_key: string;
  created_by: string;
  reverses_entry_id: string | null;
  created_at: Date;
}

async function ledgerRow(shopId: string, entryId: string): Promise<FullLedgerRow | null> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.queryOne<FullLedgerRow>(
      sql`SELECT id, shop_id, customer_id, posting_id, entry_seq, entry_type, direction,
                 amount_paise, currency, occurred_at, description, source, source_id,
                 idempotency_key, created_by, reverses_entry_id, created_at
            FROM app.ledger_entries
           WHERE shop_id = ${shopId} AND id = ${entryId}`,
    ),
  );
}

async function outboxPayloads(shopId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM app.outbox_events WHERE shop_id = ${shopId} ORDER BY queued_at`,
    ),
  );
  return rows.map((row) => row.payload);
}

function withDatabaseName(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("TEXT vertical slice through the simulator", () => {
  it("happy path: webhook -> inbox -> draft -> seller confirmation -> ledger", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    const response = await postWebhook(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await inboxCount(shopId, waId)).toBe(1);

    const inbox = await inboxRow(shopId, waId);
    expect(inbox?.status).toBe("RECEIVED");

    const processed = await processNextInboxMessageForShop(shopId, deps);
    expect(processed.outcome, processed.error).toBe("DONE");

    const pending = await drafts(shopId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.customer_name).toBe("Ramesh");
    expect(pending[0]?.amount_paise).toBe("30000");
    expect(pending[0]?.direction).toBe("DEBIT");
    expect(pending[0]?.entry_type).toBe("SALE");
    expect(pending[0]?.is_credit_sale).toBe(true);
    expect(pending[0]?.status).toBe("PENDING");
    const draftId = pending[0]?.id ?? "";

    const sentConfirmation = await processNextOutboundForShop(shopId, deps);
    expect(sentConfirmation.state).toBe("SENT");
    const confirmation = store.list({ to: phone });
    expect(
      confirmation.some(
        (message) => message.body.includes("[Confirm]") && message.body.includes("[Cancel]"),
      ),
    ).toBe(true);
    expect(
      confirmation.some((message) => message.body.includes("₹300 credit sale for Ramesh")),
    ).toBe(true);

    const confirmWaId = `wamid.${randomUUID()}`;
    const confirmResponse = await postWebhook(
      buildPayload({
        waId: confirmWaId,
        from: phone,
        type: "interactive",
        interactiveId: `confirm:${draftId}`,
      }),
    );
    expect(confirmResponse.status).toBe(200);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");

    const sentReceipt = await processNextOutboundForShop(shopId, deps);
    expect(sentReceipt.state).toBe("SENT");

    const entries = await ledger(shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount_paise).toBe("30000");
    expect(entries[0]?.direction).toBe("DEBIT");
    expect(entries[0]?.entry_type).toBe("SALE");
    expect(entries[0]?.source).toBe("WHATSAPP");
    expect(entries[0]?.idempotency_key).toBe(`draft-confirm:${draftId}`);

    const confirmed = await drafts(shopId);
    expect(confirmed[0]?.status).toBe("CONFIRMED");
    expect(confirmed[0]?.confirmed_entry_id).not.toBeNull();
    expect(await customerBalance(shopId)).toBe(30000);

    const messages = store.list({ to: phone });
    expect(messages.some((message) => message.body.includes("Entry confirmed"))).toBe(true);
  });

  it("duplicate webhook delivery creates one inbox row and one draft", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;
    const payload = buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" });

    expect((await postWebhook(payload)).status).toBe(200);
    expect((await postWebhook(payload)).status).toBe(200);
    expect(await inboxCount(shopId, waId)).toBe(1);

    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("EMPTY");
    expect(await drafts(shopId)).toHaveLength(1);
  });

  it("bad signature returns 401 and writes nothing", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    const response = await postWebhook(
      buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }),
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(response.status).toBe(401);
    expect(await inboxCount(shopId, waId)).toBe(0);
    expect(await drafts(shopId)).toHaveLength(0);
  });

  it("a persistence failure returns 500 and writes nothing", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `x`.repeat(201);

    const response = await postWebhook(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }));
    expect(response.status).toBe(500);
    expect(await inboxCount(shopId, waId)).toBe(0);
  });

  it("a crashed worker's lease expires and the message is retried", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    expect(
      (await postWebhook(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }))).status,
    ).toBe(200);

    const claimed = await claimNextForShop(shopId);
    expect(claimed?.id).toBeDefined();
    expect((await inboxRow(shopId, waId))?.status).toBe("PROCESSING");

    // Simulate a crash: the worker never marks DONE or FAILED.
    await expireLease(claimed?.id ?? "");
    expect(await reclaimExpiredLeases()).toBeGreaterThanOrEqual(1);
    expect((await inboxRow(shopId, waId))?.status).toBe("RECEIVED");

    const retried = await processNextInboxMessageForShop(shopId, deps);
    expect(retried.outcome).toBe("DONE");

    const row = await inboxRow(shopId, waId);
    expect(row?.status).toBe("DONE");
    expect(row?.attempt_count).toBe(2);
    expect(await drafts(shopId)).toHaveLength(1);
  });

  it("three failures mark the message DEAD and notify the seller", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    expect((await postWebhook(buildPayload({ waId, from: phone, text: "hello" }))).status).toBe(200);

    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("FAILED");
    await expireFailedLeases(shopId);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("FAILED");
    await expireFailedLeases(shopId);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DEAD");

    const row = await inboxRow(shopId, waId);
    expect(row?.status).toBe("DEAD");
    expect(row?.attempt_count).toBe(3);

    const notification = await processNextOutboundForShop(shopId, deps);
    expect(notification.state).toBe("SENT");
    const messages = store.list({ to: phone });
    expect(messages.some((message) => message.body.includes("could not process"))).toBe(true);
  });

  it("Confirm pressed twice posts exactly one ledger entry", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const draftWaId = `wamid.${randomUUID()}`;

    expect(
      (await postWebhook(buildPayload({ waId: draftWaId, from: phone, text: "Ramesh 300 udhaar" })))
        .status,
    ).toBe(200);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");

    const draft = (await drafts(shopId))[0];
    expect(draft).toBeDefined();
    const draftId = draft?.id ?? "";

    for (const _attempt of [1, 2]) {
      const waId = `wamid.${randomUUID()}`;
      expect(
        (
          await postWebhook(
            buildPayload({
              waId,
              from: phone,
              type: "interactive",
              interactiveId: `confirm:${draftId}`,
            }),
          )
        ).status,
      ).toBe(200);
      expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");
    }

    const entries = await ledger(shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.idempotency_key).toBe(`draft-confirm:${draftId}`);
    expect((await drafts(shopId))[0]?.status).toBe("CONFIRMED");
  });
});

describe("hardening: per-seller arrival ordering", () => {
  it("serializes same-seller inserts so an uncommitted earlier message blocks a later claim", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const firstWaId = `wamid.${randomUUID()}`;
    const secondWaId = `wamid.${randomUUID()}`;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstInserted!: () => void;
    const firstInsertedPromise = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let calls = 0;

    // The gated runner pauses the first transaction after its INSERT but before COMMIT,
    // while it still holds the seller's transaction-scoped advisory lock.
    const gatedRunner: WebhookTransactionRunner = async (fn) => {
      const call = (calls += 1);
      if (call === 2) secondStarted();
      return withTransaction(async (client) => {
        const result = await fn(client);
        if (call === 1) {
          firstInserted();
          await firstGate;
        }
        return result;
      });
    };

    const gatedApp = createApp({
      webhook: {
        appSecret: APP_SECRET,
        verifyToken: VERIFY_TOKEN,
        runTransaction: gatedRunner,
      },
    });

    const postGated = (payload: unknown) => {
      const raw = JSON.stringify(payload);
      return request(gatedApp)
        .post("/webhooks/whatsapp")
        .set("content-type", "application/json")
        .set("x-hub-signature-256", sign(raw))
        .send(raw);
    };

    const first = postGated(
      buildPayload({ waId: firstWaId, from: phone, text: "Ramesh 300 udhaar" }),
    ).then((response) => response);
    await firstInsertedPromise;

    const second = postGated(
      buildPayload({ waId: secondWaId, from: phone, text: "Suresh 500 udhaar" }),
    ).then((response) => response);
    await secondStartedPromise;

    try {
      // The second insert is genuinely blocked on the seller's advisory lock. If it had
      // committed, the claim below would process it before the earlier, still-uncommitted row.
      expect(await waitForAdvisoryWait()).toBe(true);
      const during = await processNextInboxMessageForShop(shopId, deps);
      expect(during.outcome).toBe("EMPTY");
    } finally {
      releaseFirst();
    }

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status, JSON.stringify(firstResponse.body)).toBe(200);
    expect(secondResponse.status, JSON.stringify(secondResponse.body)).toBe(200);

    const rows = await inboxRows(shopId);
    expect(rows.map((row) => row.wa_message_id)).toEqual([firstWaId, secondWaId]);
    const firstId = rows[0]?.id ?? "";
    const secondId = rows[1]?.id ?? "";
    expect(Number(rows[0]?.arrival_seq)).toBeLessThan(Number(rows[1]?.arrival_seq));

    const firstRun = await processNextInboxMessageForShop(shopId, deps);
    expect(firstRun.outcome).toBe("DONE");
    expect(firstRun.messageId).toBe(firstId);
    const secondRun = await processNextInboxMessageForShop(shopId, deps);
    expect(secondRun.outcome).toBe("DONE");
    expect(secondRun.messageId).toBe(secondId);

    const names = (await drafts(shopId)).map((draft) => draft.customer_name);
    expect(names).toContain("Ramesh");
    expect(names).toContain("Suresh");
  });

  it("a Confirm that arrives before its draft is retried, not acknowledged as DONE", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;
    const missingDraftId = randomUUID();

    expect(
      (
        await postWebhook(
          buildPayload({
            waId,
            from: phone,
            type: "interactive",
            interactiveId: `confirm:${missingDraftId}`,
          }),
        )
      ).status,
    ).toBe(200);

    const result = await processNextInboxMessageForShop(shopId, deps);
    expect(result.outcome).toBe("FAILED");
    expect(result.error).toContain("DRAFT_NOT_FOUND");
    expect((await inboxRow(shopId, waId))?.status).toBe("FAILED");
    expect(await ledger(shopId)).toHaveLength(0);
  });
});

describe("hardening: concurrent confirmation and undo", () => {
  it("two simultaneous Confirm presses post exactly one ledger row and one balance change", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    expect(
      (await postWebhook(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }))).status,
    ).toBe(200);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");

    const draftId = (await drafts(shopId))[0]?.id ?? "";
    expect(draftId).not.toBe("");

    const [first, second] = await Promise.all([
      confirmDraft(shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }),
      confirmDraft(shopId, draftId, { keyRef: env.FIELD_ENCRYPTION_KEY_REF }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["ALREADY_CONFIRMED", "CONFIRMED"]);
    const entries = await ledger(shopId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.idempotency_key).toBe(`draft-confirm:${draftId}`);
    expect(await customerBalance(shopId)).toBe(30000);

    const confirmations = (await outboxPayloads(shopId)).filter(
      (payload) =>
        typeof payload.text === "string" && payload.text.includes("Entry confirmed"),
    );
    expect(confirmations).toHaveLength(1);
  });

  it("undo appends a linked reversal, restores the balance, leaves the original intact, and rejects a second undo", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    expect(
      (await postWebhook(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }))).status,
    ).toBe(200);
    expect((await processNextInboxMessageForShop(shopId, deps)).outcome).toBe("DONE");

    const draftId = (await drafts(shopId))[0]?.id ?? "";
    const confirmed = await confirmDraft(shopId, draftId, {
      keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    const entryId = confirmed.entryId;
    expect(entryId).not.toBeNull();
    if (!entryId) throw new Error("confirmed draft did not return an entry id");
    expect(await customerBalance(shopId)).toBe(30000);

    const originalBefore = await ledgerRow(shopId, entryId);
    expect(originalBefore).not.toBeNull();

    const reversal = await reverseLedgerEntry(shopId, entryId, "seller undo");
    expect(reversal.reversalEntryId).not.toBe(entryId);
    expect(await customerBalance(shopId)).toBe(0);

    const originalAfter = await ledgerRow(shopId, entryId);
    expect(originalAfter).toEqual(originalBefore);

    const reversalRow = await ledgerRow(shopId, reversal.reversalEntryId);
    expect(reversalRow?.entry_type).toBe("REVERSAL");
    expect(reversalRow?.direction).toBe("CREDIT");
    expect(reversalRow?.amount_paise).toBe("30000");
    expect(reversalRow?.reverses_entry_id).toBe(entryId);
    expect(reversalRow?.idempotency_key).toBe(`reversal:${entryId}`);

    const secondUndo = await reverseLedgerEntry(shopId, entryId, "seller undo again").then(
      () => null,
      (error: unknown) => error,
    );
    expect(secondUndo).toBeInstanceOf(EntryAlreadyReversedError);
    expect(secondUndo).toMatchObject({ code: "ENTRY_ALREADY_REVERSED" });

    expect(await ledger(shopId)).toHaveLength(2);
    expect(await customerBalance(shopId)).toBe(0);

    // The ledger is append-only for the runtime role too, not just for application code.
    const client = await getPool().connect();
    try {
      const who = await client.query<{ user: string }>("SELECT current_user AS user");
      expect(who.rows[0]?.user).toBe("bma_app");

      const updateError = await client
        .query("UPDATE app.ledger_entries SET description = description WHERE id = $1", [entryId])
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(updateError).toMatchObject({ code: "42501" });
      expect(String((updateError as Error).message)).toMatch(/permission denied/i);

      const deleteError = await client
        .query("DELETE FROM app.ledger_entries WHERE id = $1", [entryId])
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(deleteError).toMatchObject({ code: "42501" });
      expect(String((deleteError as Error).message)).toMatch(/permission denied/i);
    } finally {
      client.release();
    }

    expect(await ledger(shopId)).toHaveLength(2);
    expect(await ledgerRow(shopId, entryId)).toEqual(originalBefore);
  });
});

describe("hardening: webhook persistence failure", () => {
  it("a real connection failure during the insert returns 500 and writes nothing", async () => {
    const phone = uniqueSellerPhone();
    const { shopId } = await seedSeller(phone);
    const waId = `wamid.${randomUUID()}`;

    const killer = new Client({ connectionString: readTestBootstrapUrl() });
    await killer.connect();
    try {
      // Insert inside a real transaction, then terminate the backend before COMMIT. This is
      // a connection failure, not a constraint violation, and PostgreSQL rolls the
      // uncommitted insert back when the backend dies. A dedicated client carries an error
      // listener because the termination is the expected outcome of this test.
      const terminatingRunner: WebhookTransactionRunner = async (fn) => {
        const client = new Client({ connectionString: readTestDatabaseUrl() });
        client.on("error", () => {
          // Expected: the backend is terminated deliberately below.
        });
        await client.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          const pidRow = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const pid = pidRow.rows[0]?.pid;
          if (!pid) throw new Error("could not read the backend pid");
          await killer.query("SELECT pg_terminate_backend($1)", [pid]);
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const alive = await killer.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]);
            if (alive.rowCount === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await client.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The connection is already gone; there is nothing to roll back on this side.
          }
          throw error;
        } finally {
          await client.end().catch(() => {
            // Already terminated by pg_terminate_backend.
          });
        }
      };

      const failingApp = createApp({
        webhook: {
          appSecret: APP_SECRET,
          verifyToken: VERIFY_TOKEN,
          runTransaction: terminatingRunner,
        },
      });

      const raw = JSON.stringify(buildPayload({ waId, from: phone, text: "Ramesh 300 udhaar" }));
      const response = await request(failingApp)
        .post("/webhooks/whatsapp")
        .set("content-type", "application/json")
        .set("x-hub-signature-256", sign(raw))
        .send(raw);

      expect(response.status, JSON.stringify(response.body)).toBe(500);
      expect(response.body).toMatchObject({ ok: false, error: { code: "PERSISTENCE_FAILED" } });
      expect(await inboxCount(shopId, waId)).toBe(0);
      expect(await drafts(shopId)).toHaveLength(0);
    } finally {
      await killer.end();
    }
  });
});

describe("hardening: startup encoding guard", () => {
  it("reports UTF8 for the configured database", async () => {
    const info = await connectDb(readTestDatabaseUrl());
    expect(info.encoding).toBe("UTF8");
  });

  it("refuses to start when the database encoding is not UTF8", async () => {
    const database = `bma_win1252_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const bootstrap = new Client({ connectionString: readTestBootstrapUrl() });
    await bootstrap.connect();
    try {
      await bootstrap.query(
        `CREATE DATABASE ${database} ENCODING 'WIN1252' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`,
      );
      await bootstrap.query(`GRANT CONNECT ON DATABASE ${database} TO bma_app`);

      const probeUri = withDatabaseName(readTestDatabaseUrl(), database);
      const error = await connectDb(probeUri).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toMatch(/encoding WIN1252/);
      expect(String((error as Error).message)).toMatch(/requires UTF8/);
    } finally {
      await bootstrap.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [database],
      );
      await bootstrap.query(`DROP DATABASE IF EXISTS ${database}`);
      await bootstrap.end();
    }
  });
});
