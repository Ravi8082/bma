import { describe, expect, it } from "vitest";
import { phoneBlindIndex } from "./blindIndex";
import { decryptField, encryptField, readKeyVersion } from "./fieldEncryption";

describe("blind index", () => {
  const key = "test-blind-index-key-32-bytes-min";

  it("is deterministic for the same input", () => {
    const a = phoneBlindIndex("+919876543210", key);
    const b = phoneBlindIndex("+919876543210", key);
    expect(a.equals(b)).toBe(true);
  });

  it("differs for different inputs", () => {
    const a = phoneBlindIndex("+919876543210", key);
    const b = phoneBlindIndex("+919876543211", key);
    expect(a.equals(b)).toBe(false);
  });

  it("differs for different keys", () => {
    const a = phoneBlindIndex("+919876543210", key);
    const b = phoneBlindIndex("+919876543210", "another-key-32-bytes-minimum!!");
    expect(a.equals(b)).toBe(false);
  });
});

describe("field encryption", () => {
  const keyRef = "test-kms-key-ref";

  it("round-trips plaintext", () => {
    const plaintext = "Sharma Tiffin, 42 MG Road";
    const ct = encryptField(plaintext, keyRef, 1);
    expect(decryptField(ct, keyRef)).toBe(plaintext);
  });

  it("stores the key version in the ciphertext", () => {
    const ct = encryptField("hello", keyRef, 3);
    expect(readKeyVersion(ct)).toBe(3);
  });

  it("uses a unique IV per encryption", () => {
    const a = encryptField("same", keyRef, 1);
    const b = encryptField("same", keyRef, 1);
    expect(a.equals(b)).toBe(false);
  });

  it("fails to decrypt with a tampered ciphertext", () => {
    const ct = encryptField("secret", keyRef, 1);
    const last = ct.length - 1;
    ct[last] = (ct[last] ?? 0) ^ 1;
    expect(() => decryptField(ct, keyRef)).toThrow();
  });

  it("supports key rotation (old version still decrypts)", () => {
    const oldCt = encryptField("old data", keyRef, 1);
    const newCt = encryptField("new data", keyRef, 2);
    expect(decryptField(oldCt, keyRef)).toBe("old data");
    expect(decryptField(newCt, keyRef)).toBe("new data");
    expect(readKeyVersion(oldCt)).toBe(1);
    expect(readKeyVersion(newCt)).toBe(2);
  });
});
