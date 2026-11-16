import { randomUUID } from "node:crypto";
import type { TenantDb } from "../../db/tenant";
import { sql } from "../../db/sql";
import { encryptField } from "../../crypto/fieldEncryption";
import { phoneBlindIndex } from "../../crypto/blindIndex";
import { normalisePhone } from "../../crypto/phone";

export interface CustomerMatch {
  customerId: string | null;
  ambiguous: boolean;
  candidateIds: string[];
}

export function normaliseName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export async function findOrCreateCustomer(
  db: TenantDb,
  shopId: string,
  name: string,
  _blindIndexKey: string,
): Promise<CustomerMatch> {
  const normalized = normaliseName(name);
  const existing = await db.query<{ id: string }>(
    sql`SELECT id FROM app.customers
         WHERE shop_id = ${shopId} AND name_normalized = ${normalized}
         ORDER BY created_at`,
  );
  if (existing.length > 1) {
    return { customerId: null, ambiguous: true, candidateIds: existing.map((r) => r.id) };
  }
  if (existing.length === 1) {
    return { customerId: existing[0]!.id, ambiguous: false, candidateIds: [existing[0]!.id] };
  }
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO app.customers (id, shop_id, name, name_normalized, balance_paise)
        VALUES (${id}, ${shopId}, ${name.trim()}, ${normalized}, 0)`,
  );
  return { customerId: id, ambiguous: false, candidateIds: [id] };
}

export async function attachPhone(
  db: TenantDb,
  shopId: string,
  customerId: string,
  phone: string,
  keyRef: string,
  blindIndexKey: string,
): Promise<{ ok: boolean; reason?: string }> {
  let normalized: string;
  try {
    normalized = normalisePhone(phone);
  } catch {
    return { ok: false, reason: "INVALID_PHONE" };
  }
  const bidx = phoneBlindIndex(normalized, blindIndexKey);
  // One phone -> one customer per shop.
  const clash = await db.query<{ id: string }>(
    sql`SELECT id FROM app.customers
         WHERE shop_id = ${shopId} AND phone_bidx = ${bidx} AND id <> ${customerId}`,
  );
  if (clash.length > 0) {
    return { ok: false, reason: "PHONE_ALREADY_USED" };
  }
  const enc = encryptField(normalized, keyRef, 1, {
    shopId,
    table: "customers",
    column: "phone_enc",
  });
  await db.execute(
    sql`UPDATE app.customers
           SET phone_enc = ${enc}, phone_bidx = ${bidx}, key_version = 1, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${customerId}`,
  );
  return { ok: true };
}

export async function setLocatorNote(
  db: TenantDb,
  shopId: string,
  customerId: string,
  note: string,
  keyRef: string,
): Promise<void> {
  const enc = encryptField(note.slice(0, 500), keyRef, 1, {
    shopId,
    table: "customers",
    column: "notes_enc",
  });
  await db.execute(
    sql`UPDATE app.customers SET notes_enc = ${enc}, updated_at = now()
         WHERE shop_id = ${shopId} AND id = ${customerId}`,
  );
}
