/**
 * Per-seller advisory lock key.
 *
 * The webhook uses this key to serialize inserts for one seller; the claim service uses the
 * same key so a worker cannot claim a seller's messages while an earlier insert is still
 * uncommitted. A 64-bit signed key keeps it inside PostgreSQL `bigint`.
 */
export function sellerAdvisoryKey(shopId: string): string {
  return BigInt.asIntN(64, BigInt(`0x${shopId.replace(/-/g, "").slice(0, 16)}`)).toString();
}
