import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_LENGTH = 2;

/**
 * Envelope field encryption for phone, address and notes.
 *
 * Format: [version: 2 bytes (big-endian)] [iv: 12 bytes] [authTag: 16 bytes] [ciphertext]
 *
 * AAD (Additional Authenticated Data) binds the ciphertext to a specific shop, table and
 * column. Copying ciphertext across rows or shops fails decryption because the AAD
 * differs. The nonce is unique per encryption (random 12 bytes).
 *
 * The key is derived from the KMS key reference and the version. In production the KMS
 * wraps a data key; here we derive deterministically from the reference for testability.
 * A decrypt failure throws and the caller writes a security_events row.
 */

function deriveKey(keyRef: string, version: number): Buffer {
  return createHash("sha256")
    .update(`${keyRef}:${version}`, "utf8")
    .digest();
}

export interface AADContext {
  shopId: string;
  table: string;
  column: string;
}

function aadBuffer(ctx: AADContext): Buffer {
  return Buffer.from(`${ctx.shopId}:${ctx.table}:${ctx.column}`, "utf8");
}

export function encryptField(
  plaintext: string,
  keyRef: string,
  version: number,
  aad?: AADContext,
): Buffer {
  if (typeof plaintext !== "string") {
    throw new Error("plaintext must be a string");
  }
  if (version < 1) {
    throw new Error("key version must be positive");
  }

  const key = deriveKey(keyRef, version);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) {
    cipher.setAAD(aadBuffer(aad));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const versionBuf = Buffer.alloc(VERSION_LENGTH);
  versionBuf.writeUInt16BE(version, 0);

  return Buffer.concat([versionBuf, iv, authTag, encrypted]);
}

export function decryptField(ciphertext: Buffer, keyRef: string, aad?: AADContext): string {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < VERSION_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("ciphertext is too short or invalid");
  }

  const version = ciphertext.readUInt16BE(0);
  const iv = ciphertext.subarray(VERSION_LENGTH, VERSION_LENGTH + IV_LENGTH);
  const authTag = ciphertext.subarray(
    VERSION_LENGTH + IV_LENGTH,
    VERSION_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const encrypted = ciphertext.subarray(VERSION_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(keyRef, version);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  if (aad) {
    decipher.setAAD(aadBuffer(aad));
  }

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

export function readKeyVersion(ciphertext: Buffer): number {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < VERSION_LENGTH) {
    throw new Error("ciphertext is too short");
  }
  return ciphertext.readUInt16BE(0);
}
