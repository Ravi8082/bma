/**
 * Consent versioning.
 *
 * `CURRENT_CONSENT_VERSION` is bumped whenever the consent text changes materially.
 * A seller whose latest consent record carries an older version must re-consent
 * before any new processing that depends on the new terms.
 */
export const CURRENT_CONSENT_VERSION = "privacy-v2";

export const CONSENT_TEXT = [
  "I agree to my business entries being processed to provide bookkeeping.",
  "Message text, including customer names, is processed by a third-party",
  "language-model provider to extract entries. Phone numbers, addresses and",
  "ledger data are never sent to that provider.",
].join(" ");

export function needsReconsent(recordedVersion: string | null | undefined): boolean {
  return recordedVersion !== CURRENT_CONSENT_VERSION;
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
