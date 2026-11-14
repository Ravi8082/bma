import { createHmac, randomInt, randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { getPool } from "../../config/db";
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
import { usePostgres } from "../helpers/postgres";

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
