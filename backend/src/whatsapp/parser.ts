/**
 * Deterministic text parser for the Phase 4 text slice.
 */
import { normalisePhone } from "../crypto/phone";

export type DraftEntryType = "SALE" | "PAYMENT_IN" | "PURCHASE" | "PAYMENT_OUT" | "EXPENSE";

export interface ParsedEntry {
  customerName: string;
  amountPaise: number;
  entryType: DraftEntryType;
  direction: "DEBIT" | "CREDIT";
  isCreditSale: boolean;
  typeUnclear: boolean;
  /** Seller phone captured inline in the message, normalised to E.164. */
  sellerPhone?: string | null;
}

export type ParseResult =
  | { kind: "PARSED"; entry: ParsedEntry }
  | { kind: "MULTI"; entries: ParsedEntry[] }
  | { kind: "NEEDS_CLARIFICATION"; reason: string; options: string[] }
  | { kind: "NOT_AN_ENTRY" };

export interface EntryParser {
  readonly name: string;
  parse(text: string, options?: { maxAmountPaise?: number }): ParseResult;
  parseAsync?(text: string, options?: { maxAmountPaise?: number }): Promise<ParseResult>;
}

const MONEY_PREFIX = /^(?:₹|rs\.?|inr)/i;
const PHONE_LIKE = /^\d{10,}$/;
const PAYMENT_WORDS = /(payment|jama|received from|se mila|se mile|paid|mile)/i;

const WORD_TO_NUM: Record<string, number> = { ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10 };
const NUMBER_WORDS: Record<string, number> = { dedh: 1.5, paune: 0.75 };
const RETURN_WORD_RE = /\b(wapas|vaapas|parichay|parat|repay|return|refund)\b/i;

/** Parse a money token that may carry an optional currency prefix and digit grouping. */
export function parseMoneyToken(token: string): number | null {
  let t = token.trim();
  const prefix = MONEY_PREFIX.exec(t);
  if (prefix) t = t.slice(prefix[0].length).trim();
  t = t.replace(/[\s/-]*$/, "");
  const dot = t.indexOf(".");
  const intPart = dot >= 0 ? t.slice(0, dot) : t;
  const fracPart = dot >= 0 ? t.slice(dot + 1) : "";
  const intClean = intPart.replace(/,/g, "");
  const fracClean = fracPart.replace(/,/g, "");
  if (!/^\d+$/.test(intClean)) return null;
  if (dot >= 0 && !/^\d{1,2}$/.test(fracClean)) return null;
  const whole = Number.parseInt(intClean, 10);
  const frac = fracClean ? Number.parseInt(fracClean.padEnd(2, "0"), 10) : 0;
  const paise = whole * 100 + frac;
  return paise > 0 ? paise : null;
}

function isMoneyToken(token: string): boolean {
  return parseMoneyToken(token) !== null;
}

function hasReturnWord(text: string): boolean {
  if (RETURN_WORD_RE.test(text)) return true;
  const lower = text.toLowerCase();
  const devanagari = ["वापस", "वापसी", "रिफंड", "परत", "परतणे"];
  return devanagari.some((w) => lower.includes(w));
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
    if (hasReturnWord(trimmed)) {
      return { kind: "NEEDS_CLARIFICATION", reason: "return_or_repay", options: ["goods_returned", "money_returned", "cancel"] };
    }

    // Conjunction of multiple people with a single amount -> ask how to split.
    const CONJ_RE = /\b(aur|and)\b/i;
    const devanagariConj = ["और", "आणि", "aur"];
    const hasConjunction = CONJ_RE.test(trimmed) || devanagariConj.some((w) => trimmed.includes(w));
    if (hasConjunction) {
      // ensure at least two name-like tokens
      const ascii2 = toAsciiDigits(trimmed);
      const toks2 = ascii2.split(/\s+/);
      const moneyIdx = toks2.findIndex((t) => parseMoneyToken(t) !== null);
      const nameToks = (moneyIdx >= 0 ? toks2.slice(0, moneyIdx) : toks2).filter(
        (t) => !/^(aur|and|ko|ne|ka|ki|ke|to|credit|paid|dedh|paune|sau|hazaar|hazar|teen|ek|do)$/i.test(t) &&
          !parseMoneyToken(t) && !/^\d{10,}$/.test(t.replace(/\D/g, "")),
      );
      if (nameToks.length >= 2) {
        const m = moneyIdx >= 0 ? parseMoneyToken(toks2[moneyIdx]!) : null;
        const amt = m ? m / 100 : 0;
        return {
          kind: "NEEDS_CLARIFICATION",
          reason: "shared_amount",
          options: [`${amt} each`, `${amt} total split`, "Cancel"],
        };
      }
    }

    // Multiple independent entries in one message -> MULTI with one draft per entry.
    const segments = trimmed.split(/[\n\r]+|\s+aur\s+|,\s*(?=\D)/i).map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length > 1) {
      const entries: ParsedEntry[] = [];
      for (const seg of segments) {
        const r = deterministicParser.parse(seg, options);
        if (r.kind === "PARSED") entries.push(r.entry);
      }
      if (entries.length > 1) {
        const first = entries[0]!;
        const sameCustomer = entries.every((e) => e.customerName.toLowerCase() === first.customerName.toLowerCase());
        if (sameCustomer) {
          const amounts = entries.map((e) => e.amountPaise);
          const sale = amounts[0]! / 100;
          const received = amounts[1]! / 100;
          return {
            kind: "NEEDS_CLARIFICATION",
            reason: "multiple_amounts_same_customer",
            options: [
              `Sale ${sale}, received ${received}, balance ${sale - received}`,
              `Sale ${received} only`,
              "Cancel",
            ],
          };
        }
        return { kind: "MULTI", entries };
      }
    }

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
      const v = parseMoneyToken(tokens[i] ?? "");
      if (v !== null) return { value: v, end: i };
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
    if (amountPaise >= max) {
      return { kind: "NEEDS_CLARIFICATION", reason: "amount_above_ceiling", options: ["split_payment", "cancel"] };
    }

    // Multiple distinct digit numbers -> clarification
    const digitTokens = tokens.filter((t) => isMoneyToken(t) && !PHONE_LIKE.test(t.replace(/\D/g, "")));
    const distinctDigits = new Set(digitTokens);
    if (digitTokens.length > 1 && distinctDigits.size > 1) {
      const amounts = [...distinctDigits].map((d) => parseMoneyToken(d)!).filter((a) => a > 0);
      if (amounts.length >= 2) {
        const sale = amounts[0]! / 100;
        const received = amounts[1]! / 100;
        return {
          kind: "NEEDS_CLARIFICATION",
          reason: "multiple_amounts_same_customer",
          options: [
            `Sale ${sale}, received ${received}, balance ${sale - received}`,
            `Sale ${received} only`,
            "Cancel",
          ],
        };
      }
      return { kind: "NEEDS_CLARIFICATION", reason: "multiple_amounts", options: ["cancel"] };
    }

    // Name extraction
    let nameTokens: string[];
    const toIndex = tokens.findIndex((t, i) => i > amountIndex && /^to$/i.test(t));
    if (toIndex >= 0) {
      nameTokens = tokens.slice(toIndex + 1).filter((token) => !isMoneyToken(token) && !PHONE_LIKE.test(token.replace(/\D/g, "")));
    } else {
      nameTokens = tokens
        .slice(0, amountIndex)
        .filter(
          (token) =>
            !isMoneyToken(token) &&
            !PHONE_LIKE.test(token.replace(/\D/g, "")) &&
            !/^(ko|ne|ka|ki|ke|to|credit|paid|dedh|paune|sau|hazaar|hazar|teen)$/i.test(token),
        );
    }
    nameTokens = nameTokens.filter((t) => !/^paid$/i.test(t) && !PHONE_LIKE.test(t.replace(/\D/g, "")));
    const sellerPhoneToken = tokens.slice(0, amountIndex).find((t) => PHONE_LIKE.test(t.replace(/\D/g, "")));
    const sellerPhone = sellerPhoneToken ? normalisePhone(sellerPhoneToken) : null;
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
          sellerPhone,
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
        sellerPhone,
      },
    };
  },
};

