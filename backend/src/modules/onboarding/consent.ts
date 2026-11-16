/**
 * Consent versioning.
 *
 * `CURRENT_CONSENT_VERSION` is bumped whenever the consent text changes materially.
 * A seller whose latest consent record carries an older version must re-consent
 * before any new processing that depends on the new terms.
 */
export const CURRENT_CONSENT_VERSION = "privacy-v3";

export const CONSENT_TEXT = [
  "I agree to my business entries being processed to provide bookkeeping.",
  "Message text, including customer names, is processed by a third-party",
  "language-model provider to extract entries. Phone numbers, addresses and",
  "ledger data are never sent to that provider.",
  "Evening summary templates may include your name, shop name, totals and",
  "entry counts; no customer names or phone numbers are included.",
].join(" ");

export function needsReconsent(recordedVersion: string | null | undefined): boolean {
  return recordedVersion !== CURRENT_CONSENT_VERSION;
}

/** A declined consent record counts as a DECLINED state, not privacy-v1. */
export function isDeclinedVersion(version: string | null | undefined): boolean {
  return version === "declined";
}

import { withTenant } from "../../db/tenant";
import { sql } from "../../db/sql";

export async function getLatestConsentVersion(shopId: string): Promise<string | null> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "consent" }, async (db) => {
    return db.query<{ policy_version: string }>(
      sql`SELECT policy_version FROM app.consent_records
           WHERE shop_id = ${shopId} AND purpose = 'BOOKKEEPING'
           ORDER BY granted_at DESC
           LIMIT 1`,
    );
  });
  return rows[0]?.policy_version ?? null;
}

export async function consentDeclinedRecently(shopId: string): Promise<boolean> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "consent" }, async (db) => {
    return db.query<{ granted: boolean; policy_version: string; granted_at: Date }>(
      sql`SELECT granted, policy_version, granted_at FROM app.consent_records
           WHERE shop_id = ${shopId} AND purpose = 'BOOKKEEPING'
           ORDER BY granted_at DESC
           LIMIT 1`,
    );
  });
  const r = rows[0];
  if (!r) return false;
  if (r.granted) return false;
  if (r.policy_version !== "declined") return false;
  const ageMs = Date.now() - new Date(r.granted_at).getTime();
  return ageMs < 30 * 24 * 60 * 60 * 1000;
}

export async function recordConsent(shopId: string, userId: string, granted: boolean, version: string): Promise<void> {
  await withTenant({ shopId, actorType: "SYSTEM", actorId: "consent" }, async (db) => {
    await db.execute(
      sql`INSERT INTO app.consent_records (shop_id, user_id, purpose, granted, policy_version, method)
          VALUES (${shopId}, ${userId}, 'BOOKKEEPING', ${granted}, ${version}, 'WHATSAPP')`,
    );
  });
}

export async function reconsentAlreadySentToday(shopId: string): Promise<boolean> {
  const rows = await withTenant({ shopId, actorType: "SYSTEM", actorId: "consent" }, async (db) => {
    return db.query<{ count: string }>(
      sql`SELECT COUNT(*) AS count FROM app.outbox_events
           WHERE shop_id = ${shopId}
             AND queued_at > now() - interval '1 day'
             AND payload->>'text' ILIKE '%re-accept the updated privacy terms%'`,
    );
  });
  return Number(rows[0]?.count ?? "0") > 0;
}
