import { MoneyError, assertSafeInteger, paise, type Paise } from "./money";

/** PostgreSQL BIGINT arrives from `pg` as a decimal string. */
const INTEGER_TEXT = /^-?\d+$/;

/**
 * Convert a value read from PostgreSQL into paise without ever going through a float.
 *
 * `pg` returns `BIGINT` (and `SUM(bigint)`, which is `NUMERIC`) as a string. Parsing that
 * string with `Number()` is safe only while it is an integer inside the safe range; this
 * function enforces both, so a corrupt or oversized value throws instead of rounding.
 */
export function fromDatabasePaise(value: string | number | bigint): Paise {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new MoneyError(`database amount ${value.toString()} exceeds the safe integer range`);
    }
    return paise(Number(value));
  }

  if (typeof value === "number") {
    assertSafeInteger(value, "database amount");
    return paise(value);
  }

  const text = value.trim();
  if (!INTEGER_TEXT.test(text)) {
    throw new MoneyError(`database amount "${value}" is not an integer number of paise`);
  }
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`database amount "${value}" exceeds the safe integer range`);
  }
  return paise(Number(parsed));
}

/**
 * Convert paise for a bound query parameter.
 *
 * A decimal string, not a JS number: the driver must never be able to turn the value into a
 * float or an exponent form. Bound as `$n`, PostgreSQL casts it to `BIGINT`.
 */
export function toDatabasePaise(amount: Paise): string {
  assertSafeInteger(amount, "amount");
  return String(amount);
}
