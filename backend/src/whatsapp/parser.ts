/**
 * Deterministic text parser for the Phase 4 text slice.
 */
export type DraftEntryType = "SALE" | "PAYMENT_IN" | "PURCHASE" | "PAYMENT_OUT" | "EXPENSE";

export interface ParsedEntry {
  customerName: string;
  amountPaise: number;
  entryType: DraftEntryType;
  direction: "DEBIT" | "CREDIT";
  isCreditSale: boolean;
  typeUnclear: boolean;
}

export type ParseResult =
  | { kind: "PARSED"; entry: ParsedEntry }
  | { kind: "NEEDS_CLARIFICATION"; reason: string; options: string[] }
  | { kind: "NOT_AN_ENTRY" };

export interface EntryParser {
  readonly name: string;
  parse(text: string, options?: { maxAmountPaise?: number }): ParseResult;
  parseAsync?(text: string, options?: { maxAmountPaise?: number }): Promise<ParseResult>;
}

const MONEY_TOKEN = /^(?:₹|rs\.?|inr)?\s*(\d{1,9})(?:\.(\d{1,2}))?\/?-?$/i;
const PHONE_LIKE = /^\d{10,}$/;
const PAYMENT_WORDS = /(payment|jama|received from|se mila|se mile|paid|mile)/i;

const CASH_WORDS = /(cash|nakad|received|mila)/i;
const WORD_TO_NUM: Record<string, number> = { ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10 };
const NUMBER_WORDS: Record<string, number> = { dedh: 1.5, paune: 0.75 };

function toPaise(whole: string, fraction: string | undefined): number {
  const wholePart = Number.parseInt(whole, 10);
  if (!Number.isSafeInteger(wholePart) || wholePart < 0) throw new Error("invalid rupee amount");
  const paisePart = fraction ? Number.parseInt(fraction.padEnd(2, "0"), 10) : 0;
  return wholePart * 100 + paisePart;
}

function cleanName(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[,.-]+|[,.-]+$/g, "").trim();
}

function toAsciiDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
          .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

function parseNumberWordToken(tok: string): number | null {
  const lower = tok.toLowerCase();
  if (NUMBER_WORDS[lower] !== undefined) return NUMBER_WORDS[lower]!;
  if (WORD_TO_NUM[lower] !== undefined) return WORD_TO_NUM[lower]!;
  return null;
}

export const deterministicParser: EntryParser = {
  name: "deterministic-v1",
  parse(text: string, options: { maxAmountPaise?: number } = {}): ParseResult {
    if (typeof text !== "string") return { kind: "NOT_AN_ENTRY" };
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 1000) return { kind: "NOT_AN_ENTRY" };

    const ascii = toAsciiDigits(trimmed);
    const tokens = ascii.split(/\s+/);
    let amountPaise: number | null = null;
    let amountIndex = -1;

    function tryNumberPhrase(i: number): { value: number; end: number } | null {
      const t0 = (tokens[i] ?? "").toLowerCase();
      if (t0 === "paune" && tokens[i + 1]) {
        const baseNum = parseNumberWordToken(tokens[i + 1]!) ?? Number(tokens[i + 1]);
        if (Number.isFinite(baseNum)) {
          const mult = (tokens[i + 2]?.toLowerCase() === "sau") ? 100 : (tokens[i + 2]?.toLowerCase() === "hazaar" || tokens[i + 2]?.toLowerCase() === "hazar") ? 1000 : 1;
          const end = (tokens[i + 2]?.toLowerCase() === "sau" || tokens[i + 2]?.toLowerCase() === "hazaar" || tokens[i + 2]?.toLowerCase() === "hazar") ? i + 2 : i + 1;
          const val = (baseNum - 0.25) * mult * 100;
          if (val > 0) return { value: Math.round(val), end };
        }
      }
      const nw = parseNumberWordToken(t0);
      if (nw !== null) {
        let mult = 1;
        let end = i;
        const next = tokens[i + 1]?.toLowerCase();
        if (next === "sau") { mult = 100; end = i + 1; }
        else if (next === "hazaar" || next === "hazar") { mult = 1000; end = i + 1; }
        const val = Math.round(nw * mult * 100);
        if (val > 0) return { value: val, end };
      }
      const m = MONEY_TOKEN.exec(tokens[i] ?? "");
      if (m) {
        try {
          const v = toPaise(m[1] ?? "0", m[2]);
          if (v > 0) return { value: v, end: i };
        } catch { return null; }
      }
      return null;
    }

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? "";
      if (PHONE_LIKE.test(token.replace(/\D/g, ""))) continue;
      const phrase = tryNumberPhrase(index);
      if (phrase) {
        amountPaise = phrase.value;
        amountIndex = phrase.end;
        break;
      }
    }

    if (amountPaise === null || amountIndex < 0) {
      // No amount found: if it looks like a greeting/help, NOT_AN_ENTRY; else clarification.
      if (/^(hi|hello|hey|namaste|hola)$/i.test(trimmed)) return { kind: "NOT_AN_ENTRY" };
      return { kind: "NOT_AN_ENTRY" };
    }
    const max = options.maxAmountPaise ?? 100_000_000_000;
    if (amountPaise > max) return { kind: "NOT_AN_ENTRY" };

    // Multiple distinct digit numbers -> clarification
    const digitTokens = tokens.filter((t) => MONEY_TOKEN.test(t));
    const distinctDigits = new Set(digitTokens);
    if (digitTokens.length > 1 && distinctDigits.size > 1) {
      return { kind: "NEEDS_CLARIFICATION", reason: "multiple_amounts", options: ["use_first", "cancel"] };
    }

    // Name extraction
    let nameTokens: string[];
    const toIndex = tokens.findIndex((t, i) => i > amountIndex && /^to$/i.test(t));
    if (toIndex >= 0) {
      nameTokens = tokens.slice(toIndex + 1).filter((token) => !MONEY_TOKEN.test(token));
    } else {
      nameTokens = tokens
        .slice(0, amountIndex)
        .filter((token) => !MONEY_TOKEN.test(token) && !/^(ko|ne|ka|ki|ke|to|credit|paid|dedh|paune|sau|hazaar|hazar|teen)$/i.test(token));
    }
    nameTokens = nameTokens.filter((t) => !/^paid$/i.test(t));
    // Strip Devanagari case suffixes (रमेशला -> रमेश)
    nameTokens = nameTokens.map((t) => t.replace(/(ला|को|ने)$/g, ""));
    const customerName = cleanName(nameTokens.join(" "));
    if (customerName.length === 0 || customerName.length > 80) {
      return { kind: "NEEDS_CLARIFICATION", reason: "missing_customer", options: [] };
    }

    // A second capitalized name after the amount (e.g. "Sunita 750 udhaar Ramesh")
    // means the entry is ambiguous about the customer.
    const afterTokens = tokens.slice(amountIndex + 1);
    const trailingName = afterTokens.find((t) => /^[A-Z][a-z]+$/.test(t) && !/^(udhaar|cash|paid)$/i.test(t));
    if (trailingName) {
      return { kind: "NEEDS_CLARIFICATION", reason: "ambiguous_customer", options: [customerName, trailingName] };
    }

    const remainder = tokens.slice(amountIndex + 1).join(" ");
    const hasNe = /\bne\b/i.test(trimmed) || /ने/.test(trimmed);
    const hasKo = /\bko\b/i.test(trimmed) || /को/.test(trimmed) || /ला/.test(trimmed);
    const hasDiya = /\bdiya\b|\bdiye\b/i.test(trimmed) || /दिले|दिला|दिया/.test(trimmed);
    const hasUdhaar = /udhaar|उधार/.test(trimmed);
    const hasCash = /cash|nakad|नकद/.test(trimmed);
    const hasProductIndicator = /\bka\b|\bki\b|\bke\b/i.test(trimmed) || /flower|maal|saman|item|माल|चा/.test(trimmed);

    const isPayment = PAYMENT_WORDS.test(trimmed) || (hasNe && hasDiya);

    // "diya/diye" direction rules
    if (hasDiya && !hasNe) {
      if (!(hasKo && hasProductIndicator)) {
        return { kind: "NEEDS_CLARIFICATION", reason: "direction_ambiguous", options: ["credit", "cash"] };
      }
    }

    const typeUnclear = !isPayment && !hasUdhaar && !hasCash;

    if (isPayment) {
      return {
        kind: "PARSED",
        entry: {
          customerName,
          amountPaise,
          entryType: "PAYMENT_IN",
          direction: "CREDIT",
          isCreditSale: false,
          typeUnclear: false,
        },
      };
    }

    return {
      kind: "PARSED",
      entry: {
        customerName,
        amountPaise,
        entryType: "SALE",
        direction: "DEBIT",
        isCreditSale: hasUdhaar ? true : !hasCash,
        typeUnclear,
      },
    };
  },
};
