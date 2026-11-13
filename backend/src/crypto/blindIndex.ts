import { createHmac } from "node:crypto";

/**
 * Blind index: deterministic HMAC-SHA256 over the normalised phone, using a separate key.
 *
 * Returns a Buffer suitable for storage in a `bytea` column and for exact-match lookup.
 * The key must come from the secret manager, never from the database.
 */
export function phoneBlindIndex(normalisedPhone: string, key: string): Buffer {
  if (typeof normalisedPhone !== "string" || normalisedPhone.length === 0) {
    throw new Error("normalisedPhone is required");
  }
  if (typeof key !== "string" || key.length < 16) {
    throw new Error("blind index key must be at least 16 characters");
  }
  return createHmac("sha256", key).update(normalisedPhone, "utf8").digest();
}
