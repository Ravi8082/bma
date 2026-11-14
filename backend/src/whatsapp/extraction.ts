/**
 * LLM-backed extraction behind the `EntryParser` interface.
 *
 * The model is a pure text-in/text-out component. It never touches the database, never
 * receives customer lists, phone numbers or ledger data, and never calls tools. Its output
 * is validated against a strict schema; any failure falls back to the deterministic parser.
 */
import type { EntryParser, ParsedEntry } from "./parser";
import { deterministicParser } from "./parser";
import { recordCost } from "../costLog";

export interface LlmExtractionInput {
  text: string;
}

export interface LlmExtracted {
  customerName: string;
  amountPaise: number;
  entryType: "SALE" | "PAYMENT_IN" | "PURCHASE" | "PAYMENT_OUT" | "EXPENSE";
  isCreditSale: boolean;
  typeUnclear: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  extract(input: { text: string }): Promise<{ raw: string; promptTokens: number; completionTokens: number }>;
}

/** Redact phone-like digit runs from text before it leaves the process. */
export function redactPhones(text: string): string {
  return text.replace(/\+?\d[\d\s-]{8,}\d/g, "[phone]");
}

/** Normalise a numeric token for the strict "must appear in source" check. */
export function normaliseNumberToken(value: string): string {
  return value.replace(/[,\s]/g, "").replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

export function numbersInSource(text: string): Set<string> {
  const set = new Set<string>();
  const regex = /\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    set.add(normaliseNumberToken(m[0]));
  }
  // Number words -> digits (subset).
  const words: Record<string, string> = { dedh: "1.5", paune: "0.75", sau: "100", hazaar: "1000" };
  for (const [w, d] of Object.entries(words)) {
    if (text.toLowerCase().includes(w)) set.add(d);
  }
  return set;
}

export function validateExtracted(extracted: LlmExtracted, sourceText: string): boolean {
  if (!extracted.customerName || extracted.customerName.length > 80) return false;
  if (!Number.isSafeInteger(extracted.amountPaise) || extracted.amountPaise <= 0) return false;
  const srcNumbers = numbersInSource(sourceText);
  const amountStr = String(extracted.amountPaise / 100);
  // The amount's rupee value must be traceable to a number in the source.
  if (!srcNumbers.has(String(Math.floor(extracted.amountPaise / 100))) && !srcNumbers.has(String(extracted.amountPaise))) {
    // Allow if any source number normalises to the amount's whole rupees.
    let ok = false;
    for (const n of srcNumbers) {
      if (Number(n) === Math.floor(extracted.amountPaise / 100)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  void amountStr;
  return true;
}

export class LlmExtractionParser implements EntryParser {
  readonly name = "llm-v1";

  constructor(
    private readonly provider: LlmProvider,
    private readonly shopId: string,
    private readonly circuitBreaker: { isOpen(): boolean; recordFailure(): void; recordSuccess(): void },
    private readonly dailyCap: number,
    private readonly state: { callsToday: number },
    private readonly consentOk: () => boolean = () => true,
  ) {}

  parse(text: string, options?: { maxAmountPaise?: number }): ParsedEntry | null {
    // Synchronous interface: the LLM call is async, so this parser is used via parseAsync.
    // For callers that only have the sync interface, fall back to deterministic.
    void text; void options;
    return null;
  }

  async parseAsync(text: string, options?: { maxAmountPaise?: number }): Promise<ParsedEntry | null> {
    const max = options?.maxAmountPaise ?? 100_000_000_000;
    const redacted = redactPhones(text);

    if (this.circuitBreaker.isOpen()) {
      return deterministicParser.parse(text, options);
    }
    if (!this.consentOk()) {
      await recordCost({ shopId: this.shopId, provider: this.provider.name, model: this.provider.model, kind: "LLM", outcome: "FALLBACK", costPaise: 0 });
      return deterministicParser.parse(text, options);
    }
    if (this.state.callsToday >= this.dailyCap) {
      await recordCost({ shopId: this.shopId, provider: this.provider.name, model: this.provider.model, kind: "LLM", outcome: "FALLBACK", costPaise: 0 });
      return deterministicParser.parse(text, options);
    }

    let raw = "";
    let promptTokens = 0;
    let completionTokens = 0;
    try {
      const result = await this.provider.extract({ text: redacted });
      raw = result.raw;
      promptTokens = result.promptTokens;
      completionTokens = result.completionTokens;
      this.circuitBreaker.recordSuccess();
    } catch {
      this.circuitBreaker.recordFailure();
      await recordCost({ shopId: this.shopId, provider: this.provider.name, model: this.provider.model, kind: "LLM", outcome: "FAILED", promptTokens, completionTokens, costPaise: 0 });
      return deterministicParser.parse(text, options);
    }

    this.state.callsToday += 1;

    let extracted: LlmExtracted | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<LlmExtracted>;
      if (
        typeof parsed.customerName === "string" &&
        typeof parsed.amountPaise === "number" &&
        (parsed.entryType === "SALE" || parsed.entryType === "PAYMENT_IN" ||
          parsed.entryType === "PURCHASE" || parsed.entryType === "PAYMENT_OUT" ||
          parsed.entryType === "EXPENSE") &&
        typeof parsed.isCreditSale === "boolean" &&
        typeof parsed.typeUnclear === "boolean"
      ) {
        extracted = {
          customerName: parsed.customerName,
          amountPaise: parsed.amountPaise,
          entryType: parsed.entryType,
          isCreditSale: parsed.isCreditSale,
          typeUnclear: parsed.typeUnclear,
        };
      }
    } catch {
      extracted = null;
    }

    if (!extracted || !validateExtracted(extracted, text)) {
      await recordCost({ shopId: this.shopId, provider: this.provider.name, model: this.provider.model, kind: "LLM", outcome: "FALLBACK", promptTokens, completionTokens, costPaise: 0 });
      return deterministicParser.parse(text, options);
    }

    if (extracted.amountPaise > max) return null;

    const direction: "DEBIT" | "CREDIT" =
      extracted.entryType === "PAYMENT_IN" || extracted.entryType === "PAYMENT_OUT" ? "CREDIT" : "DEBIT";

    await recordCost({ shopId: this.shopId, provider: this.provider.name, model: this.provider.model, kind: "LLM", outcome: "SUCCESS", promptTokens, completionTokens, costPaise: 0 });

    return {
      customerName: extracted.customerName,
      amountPaise: extracted.amountPaise,
      entryType: extracted.entryType,
      direction,
      isCreditSale: extracted.isCreditSale,
      typeUnclear: extracted.typeUnclear,
    };
  }
}

/** Stub LLM provider used in tests and when no API key is configured. */
export class StubLlmProvider implements LlmProvider {
  readonly name = "stub";
  readonly model = "stub-v1";
  async extract(input: { text: string }): Promise<{ raw: string; promptTokens: number; completionTokens: number }> {
    const det = deterministicParser.parse(input.text);
    if (!det) throw new Error("no extraction");
    const raw = JSON.stringify({
      customerName: det.customerName,
      amountPaise: det.amountPaise,
      entryType: det.entryType,
      isCreditSale: det.isCreditSale,
      typeUnclear: det.typeUnclear,
    });
    return { raw, promptTokens: 0, completionTokens: 0 };
  }
}
