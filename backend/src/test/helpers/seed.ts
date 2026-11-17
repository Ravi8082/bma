import { randomInt, randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { sql } from "../../db/sql";
import { withTenant } from "../../db/tenant";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { processNextOutboundForShop } from "../../whatsapp/outboundSender";

export function uniquePhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

export interface SeededShop {
  shopId: string;
  phone: string;
  bidx: Buffer;
  userId: string;
  messageId: string;
  store: SimulatorStore;
  messaging: SimulatorMessagingProvider;
}

export interface SeedShopOptions {
  name?: string;
  timeZone?: string;
  eveningTime?: string;
  templateSet?: string | null;
  /** Optional per-shop free-pilot ceilings; omitted columns keep the NULL default. */
  pilotDailyCapPaise?: number;
  pilotMonthlyCapPaise?: number;
  /** Makes the shop's only inbox message older than the 24-hour service window. */
  windowClosed?: boolean;
}

/** Minimal shop + owner + shop_settings + one DONE inbox message. */
export async function seedShop(options: SeedShopOptions = {}): Promise<SeededShop> {
  const shopId = randomUUID();
  const phone = uniquePhone();
  const userId = randomUUID();
  const messageId = randomUUID();
  const timeZone = options.timeZone ?? "Asia/Kolkata";
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const userEnc = encryptField(phone, env.FIELD_ENCRYPTION_KEY_REF, 1, {
    shopId,
    table: "users",
    column: "phone_enc",
  });

  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.shops (id, name, slug, preset_key, timezone)
          VALUES (${shopId}, ${options.name ?? "Test shop"}, ${`t-${shopId.slice(0, 8)}`},
                  'FLOWER_SELLER', ${timeZone})`,
    );
    await db.execute(
      sql`INSERT INTO app.users (id, shop_id, role, name, phone_enc, phone_bidx, key_version, status)
          VALUES (${userId}, ${shopId}, 'OWNER', 'Seller', ${userEnc}, ${bidx}, 1, 'ACTIVE')`,
    );
    await db.execute(
      sql`INSERT INTO app.shop_settings
            (shop_id, preset_key, language, timezone, evening_summary_time, template_set,
             pilot_daily_cap_paise, pilot_monthly_cap_paise)
          VALUES (${shopId}, 'FLOWER_SELLER', 'hi', ${timeZone},
                  ${options.eveningTime ?? "18:30"}, ${options.templateSet ?? null},
                  ${options.pilotDailyCapPaise ?? null}, ${options.pilotMonthlyCapPaise ?? null})`,
    );
    await db.execute(
      sql`INSERT INTO app.inbox_messages
            (id, shop_id, wa_message_id, from_phone_bidx, message_type, raw_payload, body_hash,
             status, received_at, arrival_seq)
          VALUES (${messageId}, ${shopId}, ${`w-${messageId.slice(0, 8)}`}, ${bidx}, 'TEXT',
                  '{}'::jsonb, ${bidx}, 'DONE', now(), 1)`,
    );
    if (options.windowClosed) {
      await db.execute(
        sql`UPDATE app.inbox_messages SET received_at = now() - interval '25 hours' WHERE id = ${messageId}`,
      );
    }
  });

  const store = new SimulatorStore();
  return { shopId, phone, bidx, userId, messageId, store, messaging: new SimulatorMessagingProvider(store) };
}

export interface SeedDraftOptions {
  customerName?: string;
  amountPaise?: number;
  entryType?: "SALE" | "PAYMENT_IN" | "PURCHASE" | "PAYMENT_OUT" | "EXPENSE";
  direction?: "DEBIT" | "CREDIT";
  isCreditSale?: boolean;
  typeUnclear?: boolean;
  items?: unknown;
  entryIndex?: number;
  customerId?: string | null;
  customerBalancePaise?: number;
}

/** One PENDING draft, optionally with a customer and item lines. */
export async function seedDraft(shop: SeededShop, options: SeedDraftOptions = {}): Promise<string> {
  const draftId = randomUUID();
  const customerId = options.customerId === undefined ? randomUUID() : options.customerId;
  const name = options.customerName ?? "Ramesh";
  const sellerEnc = encryptField(shop.phone, env.FIELD_ENCRYPTION_KEY_REF, 1, {
    shopId: shop.shopId,
    table: "entry_drafts",
    column: "seller_phone_enc",
  });

  await withTenant({ shopId: shop.shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    if (customerId) {
      await db.execute(
        sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, balance_paise)
            VALUES (${customerId}, ${shop.shopId}, ${name}, ${name.toLowerCase()},
                    ${options.customerBalancePaise ?? 0})`,
      );
    }
    await db.execute(
      sql`INSERT INTO app.entry_drafts
            (id, shop_id, source_message_id, wa_message_id, customer_id, customer_name,
             entry_type, direction, amount_paise, is_credit_sale, type_unclear, raw_text,
             source_tag, status, seller_phone_enc, seller_phone_bidx, key_version, entry_index,
             items)
          VALUES
            (${draftId}, ${shop.shopId}, ${shop.messageId}, ${`w-${shop.messageId.slice(0, 8)}`},
             ${customerId}, ${name}, ${options.entryType ?? "SALE"}, ${options.direction ?? "DEBIT"},
             ${options.amountPaise ?? 30_000}, ${options.isCreditSale ?? true},
             ${options.typeUnclear ?? false}, 'seeded draft', 'SELLER', 'PENDING',
             ${sellerEnc}, ${shop.bidx}, 1, ${options.entryIndex ?? 0},
             ${JSON.stringify(options.items ?? [])}::jsonb)`,
    );
  });

  return draftId;
}

export async function deliverText(
  shopId: string,
  phone: string,
  text: string,
  seq: number,
): Promise<void> {
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

export async function deliverButton(
  shopId: string,
  phone: string,
  buttonId: string,
  seq: number,
): Promise<void> {
  const bidx = phoneBlindIndex(phone, env.PHONE_BLIND_INDEX_KEY);
  const id = randomUUID();
  const body = {
    from: phone,
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: buttonId, title: "Button" } },
  };
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.inbox_messages
            (id, shop_id, wa_message_id, from_phone_bidx, message_type, body, raw_payload, body_hash,
             status, received_at, arrival_seq)
          VALUES (${id}, ${shopId}, ${`w-${id.slice(0, 8)}`}, ${bidx}, 'INTERACTIVE',
                  ${JSON.stringify(body)}::jsonb, '{}'::jsonb, ${bidx}, 'RECEIVED', now(), ${seq})`,
    );
  });
}

export interface OutboxRow {
  id: string;
  state: string;
  payload: Record<string, unknown> & {
    text?: string;
    body?: string;
    kind?: string;
    batchId?: string;
    buttons?: { id: string; title: string }[];
  };
  last_error: string | null;
}

export async function outboxRows(shopId: string): Promise<OutboxRow[]> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) =>
    db.query<OutboxRow>(
      sql`SELECT id, state, payload, last_error FROM app.outbox_events
           WHERE shop_id = ${shopId} ORDER BY queued_at, id`,
    ),
  );
}

export async function ledgerCount(shopId: string): Promise<number> {
  return withTenant({ shopId, actorType: "SYSTEM", actorId: "test" }, async (db) => {
    const row = await db.queryOne<{ c: string }>(
      sql`SELECT COUNT(*)::text AS c FROM app.ledger_entries WHERE shop_id = ${shopId}`,
    );
    return Number.parseInt(row?.c ?? "0", 10);
  });
}

export async function drainOutbound(shop: SeededShop, keyRef = env.FIELD_ENCRYPTION_KEY_REF): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const result = await processNextOutboundForShop(shop.shopId, { messaging: shop.messaging, keyRef });
    if (result.state === "EMPTY") return;
  }
}
