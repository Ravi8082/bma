/**
 * E.164 phone normalisation for Indian sellers.
 *
 * Pure function: no I/O, no database. Table-driven tests cover 20+ cases.
 */

export class PhoneNormalisationError extends Error {
  readonly code = "INVALID_PHONE";

  constructor(message: string) {
    super(message);
    this.name = "PhoneNormalisationError";
  }
}

const DIGITS_ONLY = /^\d+$/;
const MAX_DIGITS = 15;
const MIN_DIGITS = 7;

/**
 * Normalise a raw phone string to E.164.
 *
 * Rules:
 * - Strip spaces, dashes, parentheses.
 * - If the result starts with "+", keep the country code as-is.
 * - If it starts with "00", treat as international prefix → "+…".
 * - If it starts with "0" (domestic), prepend "+91".
 * - If it is 10 digits (Indian mobile), prepend "+91".
 * - If it is 11 digits starting with "0", strip the leading 0 and prepend "+91".
 * - If it is 12 digits starting with "91", prepend "+".
 * - Otherwise reject.
 *
 * Unicode digits are rejected (sellers type Latin digits on WhatsApp).
 */
export function normalisePhone(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new PhoneNormalisationError("phone is required");
  }

  // Reject unicode digits: only ASCII digits, +, spaces, dashes, parens allowed.
  if (/[^\d\s+\-()]/.test(raw)) {
    throw new PhoneNormalisationError("phone contains invalid characters");
  }

  const stripped = raw.replace(/[\s\-()]/g, "");

  if (stripped.startsWith("+")) {
    const digits = stripped.slice(1);
    if (!DIGITS_ONLY.test(digits)) {
      throw new PhoneNormalisationError("phone contains non-digit characters");
    }
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      throw new PhoneNormalisationError("phone has invalid length");
    }
    return `+${digits}`;
  }

  if (stripped.startsWith("00")) {
    const digits = stripped.slice(2);
    if (!DIGITS_ONLY.test(digits)) {
      throw new PhoneNormalisationError("phone contains non-digit characters");
    }
    if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
      throw new PhoneNormalisationError("phone has invalid length");
    }
    return `+${digits}`;
  }

  if (!DIGITS_ONLY.test(stripped)) {
    throw new PhoneNormalisationError("phone contains non-digit characters");
  }

  // 10-digit Indian mobile
  if (stripped.length === 10) {
    return `+91${stripped}`;
  }

  // 11-digit with leading 0 (domestic)
  if (stripped.length === 11 && stripped.startsWith("0")) {
    return `+91${stripped.slice(1)}`;
  }

  // 12-digit starting with 91
  if (stripped.length === 12 && stripped.startsWith("91")) {
    return `+${stripped}`;
  }

  // 11-digit starting with 91 (missing leading 0? treat as 91 + 9 digits — invalid)
  throw new PhoneNormalisationError("phone has invalid length or format");
}

export function maskPhone(e164: string): string {
  if (e164.length < 8) return "****";
  return `${e164.slice(0, 4)}******${e164.slice(-4)}`;
}
