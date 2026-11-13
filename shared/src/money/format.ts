import { PAISE_PER_RUPEE, type Paise } from "./money";

export interface FormatInrOptions {
  /** Include the ₹ symbol. Default true. */
  symbol?: boolean;
  /** Decimal places. Default 2. */
  decimals?: 0 | 2;
  /** Show "+" for positive amounts (useful for balances). Default false. */
  showPlus?: boolean;
}

/**
 * Indian digit grouping, implemented directly instead of via Intl so the
 * output is identical on every Node build (some ICU builds insert a
 * non-breaking space after ₹, which then breaks WhatsApp copy-paste).
 *
 * 15000000 paise → "₹1,50,000.00"
 */
export function formatINR(amount: Paise, options: FormatInrOptions = {}): string {
  const { symbol = true, decimals = 2, showPlus = false } = options;

  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new Error(`formatINR expects integer paise, received ${String(amount)}`);
  }

  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const whole = Math.floor(absolute / PAISE_PER_RUPEE);
  const fraction = absolute % PAISE_PER_RUPEE;

  const wholeText = groupIndian(whole.toString());
  const fractionText =
    decimals === 2 ? `.${fraction.toString().padStart(2, "0")}` : "";

  const sign = negative ? "-" : showPlus && amount > 0 ? "+" : "";
  const prefix = symbol ? "₹" : "";
  return `${sign}${prefix}${wholeText}${fractionText}`;
}

/** 1234567 → "12,34,567" (last group of 3, then groups of 2). */
export function groupIndian(digits: string): string {
  if (!/^\d+$/.test(digits)) {
    throw new Error(`groupIndian expects digits only, received "${digits}"`);
  }
  if (digits.length <= 3) return digits;

  const lastThree = digits.slice(-3);
  let rest = digits.slice(0, -3);
  const groups: string[] = [];

  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length > 0) groups.unshift(rest);

  return `${groups.join(",")},${lastThree}`;
}
