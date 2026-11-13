/**
 * Money is always an integer number of paise (1 INR = 100 paise).
 *
 * Why a branded type: `add(rupees, paise)` is the classic bug in bookkeeping
 * software. The brand makes a raw number unusable where paise are expected, so
 * mixed units fail at compile time instead of silently producing 100x errors.
 */
declare const PAISE_BRAND: unique symbol;

export type Paise = number & { readonly [PAISE_BRAND]: true };

export const PAISE_PER_RUPEE = 100;

/** ₹10,00,00,000 — a sane per-entry ceiling for a micro-business. */
export const MAX_ENTRY_PAISE = 100_000_000_000;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function assertSafeInteger(value: number, label = "value"): void {
  if (!Number.isFinite(value)) {
    throw new MoneyError(`${label} must be finite, received ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of paise, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/** Construct a Paise value. Rejects fractions, NaN, Infinity and unsafe integers. */
export function paise(value: number): Paise {
  assertSafeInteger(value, "paise");
  return value as Paise;
}

export const ZERO: Paise = 0 as Paise;

export function add(a: Paise, b: Paise): Paise {
  assertSafeInteger(a + b, "sum");
  return (a + b) as Paise;
}

export function sub(a: Paise, b: Paise): Paise {
  assertSafeInteger(a - b, "difference");
  return (a - b) as Paise;
}

export function neg(a: Paise): Paise {
  assertSafeInteger(-a, "negation");
  return (-a) as Paise;
}

export function abs(a: Paise): Paise {
  return (a < 0 ? -a : a) as Paise;
}

export function sum(values: readonly Paise[]): Paise {
  let total = 0;
  for (const value of values) {
    total += value;
    assertSafeInteger(total, "sum");
  }
  return total as Paise;
}

export function isZero(a: Paise): boolean {
  return a === 0;
}

export function eq(a: Paise, b: Paise): boolean {
  return a === b;
}

export function gt(a: Paise, b: Paise): boolean {
  return a > b;
}

export function gte(a: Paise, b: Paise): boolean {
  return a >= b;
}

export function lt(a: Paise, b: Paise): boolean {
  return a < b;
}

export function lte(a: Paise, b: Paise): boolean {
  return a <= b;
}

export function min(a: Paise, b: Paise): Paise {
  return (a < b ? a : b) as Paise;
}

export function max(a: Paise, b: Paise): Paise {
  return (a > b ? a : b) as Paise;
}

/**
 * Divide two integers with half-up rounding, without floating point.
 * Ties round away from zero, which is what Indian invoice practice expects
 * for both positive amounts and credit/refund amounts.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  assertSafeInteger(numerator, "numerator");
  if (!Number.isSafeInteger(denominator) || denominator <= 0) {
    throw new MoneyError(`denominator must be a positive safe integer, received ${denominator}`);
  }
  const sign = numerator < 0 ? -1 : 1;
  const absNumerator = Math.abs(numerator);
  const quotient = Math.floor(absNumerator / denominator);
  const remainder = absNumerator - quotient * denominator;
  const rounded = remainder * 2 >= denominator ? quotient + 1 : quotient;
  return sign * rounded;
}

/**
 * amount × quantity where quantity is expressed in thousandths of a unit
 * (2.5 kg = 2500). Keeps fractional weights and litres in integer maths.
 */
export function multiplyByMilli(amount: Paise, milliQuantity: number): Paise {
  assertSafeInteger(milliQuantity, "milliQuantity");
  if (milliQuantity < 0) {
    throw new MoneyError("milliQuantity cannot be negative");
  }
  const product = amount * milliQuantity;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError("multiplication overflows the safe integer range");
  }
  return divRoundHalfUp(product, 1000) as Paise;
}

/** Percentage expressed in basis points: 18% = 1800, 2.5% = 250. */
export function percentOf(amount: Paise, basisPoints: number): Paise {
  assertSafeInteger(basisPoints, "basisPoints");
  if (basisPoints < 0) {
    throw new MoneyError("basisPoints cannot be negative");
  }
  const product = amount * basisPoints;
  if (!Number.isSafeInteger(product)) {
    throw new MoneyError("percentage calculation overflows the safe integer range");
  }
  return divRoundHalfUp(product, 10_000) as Paise;
}

const RUPEE_PATTERN = /^(?:₹\s*)?([+-]?)(\d[\d,]*)(?:\.(\d{1,2}))?$/;

/**
 * Parse a rupee amount typed by a human ("1,50,000.50", "₹500", "-200")
 * into exact paise. Strings are used for the fractional part so 0.1 + 0.2
 * style float drift can never enter the ledger.
 */
export function fromRupees(input: string | number): Paise {
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new MoneyError(`cannot parse amount: ${String(input)}`);
  }
  const raw = (typeof input === "number" ? input.toString() : input).trim();
  const match = RUPEE_PATTERN.exec(raw);
  if (!match) {
    throw new MoneyError(`cannot parse rupee amount "${raw}"`);
  }
  const sign = match[1] === "-" ? -1n : 1n;
  const wholeText = (match[2] ?? "").replaceAll(",", "");
  const fractionText = (match[3] ?? "").padEnd(2, "0");
  const whole = BigInt(wholeText);
  const fraction = BigInt(fractionText);
  const total = sign * (whole * 100n + fraction);
  if (total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`amount "${raw}" exceeds the safe integer range`);
  }
  return paise(Number(total));
}

/**
 * Rupee value as a JS number. FOR DISPLAY AND NON-FINANCIAL DTOs ONLY.
 * Never feed the result back into money arithmetic.
 */
export function toRupees(amount: Paise): number {
  return amount / PAISE_PER_RUPEE;
}

export function clampToEntryLimit(amount: Paise, limitPaise: Paise = paise(MAX_ENTRY_PAISE)): Paise {
  if (abs(amount) > limitPaise) {
    throw new MoneyError(`amount ${amount} exceeds the per-entry limit of ${limitPaise} paise`);
  }
  return amount;
}
