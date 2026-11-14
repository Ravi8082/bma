/**
 * Deterministic text parser for the Phase 4 text slice.
 *
 * The production extraction pipeline will put an LLM behind `EntryParser`. Until then this
 * implementation is intentionally simple, pure and testable: it never invents an amount and
 * returns null when it cannot extract a customer plus a positive amount.
 *
 * Money is integer paise. Rupees are converted with string arithmetic, never with a float.
 */

export type DraftEntryType = "SALE" | "PAYMENT_IN" | "PURCHASE" | "PAYMENT_OUT" | "EXPENSE";

export interface ParsedEntry {
  customerName: string;
  amountPaise: number;
  entryType: DraftEntryType;
  direction: "DEBIT" | "CREDIT";
  /** A credit sale increases what the customer owes; a cash sale does not. */
  isCreditSale: boolean;
}

export interface EntryParser {
  readonly name: string;
  parse(text: string, options?: { maxAmountPaise?: number }): ParsedEntry | null;
  /** Optional async path used by LLM-backed parsers. */
  parseAsync?(text: string, options?: { maxAmountPaise?: number }): Promise<ParsedEntry | null>;
}

const MONEY_TOKEN = /^(?:₹|rs\.?|inr)?\s*(\d{1,9})(?:\.(\d{1,2}))?\/?-?$/i;
const PHONE_LIKE = /^\d{10,}$/;
const CASH_WORDS = /(cash|nakad|paid|diya|diye|received|mila)/i;
const PAYMENT_WORDS = /(payment|jama|received from|se mila)/i;

function toPaise(whole: string, fraction: string | undefined): number {
  const wholePart = Number.parseInt(whole, 10);
  if (!Number.isSafeInteger(wholePart) || wholePart < 0) {
    throw new Error("invalid rupee amount");
  }
  const paisePart = fraction ? Number.parseInt(fraction.padEnd(2, "0"), 10) : 0;
  return wholePart * 100 + paisePart;
}

function cleanName(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[,.-]+|[,.-]+$/g, "")
    .trim();
}

export const deterministicParser: EntryParser = {
  name: "deterministic-v1",
  parse(text: string, options: { maxAmountPaise?: number } = {}): ParsedEntry | null {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 1000) return null;

    const tokens = trimmed.split(/\s+/);
    let amountPaise: number | null = null;
    let amountIndex = -1;

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      if (PHONE_LIKE.test(token.replace(/\D/g, ""))) continue;
      const match = MONEY_TOKEN.exec(token);
      if (!match) continue;
      try {
        const value = toPaise(match[1] ?? "0", match[2]);
        if (value > 0) {
          amountPaise = value;
          amountIndex = index;
          break;
        }
      } catch {
        return null;
      }
    }

    if (amountPaise === null || amountIndex < 0) return null;
    const max = options.maxAmountPaise ?? 100_000_000_000;
    if (amountPaise > max) return null;

    const nameTokens = tokens.slice(0, amountIndex).filter((token) => !MONEY_TOKEN.test(token));
    const customerName = cleanName(nameTokens.join(" "));
    if (customerName.length === 0 || customerName.length > 80) return null;

    const remainder = tokens.slice(amountIndex + 1).join(" ");
    const isPayment = PAYMENT_WORDS.test(trimmed);

    if (isPayment) {
      return {
        customerName,
        amountPaise,
        entryType: "PAYMENT_IN",
        direction: "CREDIT",
        isCreditSale: false,
      };
    }

    return {
      customerName,
      amountPaise,
      entryType: "SALE",
      direction: "DEBIT",
      isCreditSale: !CASH_WORDS.test(remainder),
    };
  },
};
