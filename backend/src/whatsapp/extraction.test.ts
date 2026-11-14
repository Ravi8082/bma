import { describe, expect, it } from "vitest";
import { redactPhones, normaliseNumberToken, numbersInSource, validateExtracted, StubLlmProvider, LlmExtractionParser } from "./extraction";
import { deterministicParser } from "./parser";

describe("extraction helpers", () => {
  it("redacts phone numbers", () => {
    expect(redactPhones("Ramesh 300, call 9876543210")).toBe("Ramesh 300, call [phone]");
  });

  it("collects numbers from source text", () => {
    const s = numbersInSource("Ramesh 300 udhaar");
    expect(s.has("300")).toBe(true);
  });

  it("accepts a valid extracted entry", () => {
    expect(validateExtracted({ customerName: "Ramesh", amountPaise: 30000, entryType: "SALE", isCreditSale: true }, "Ramesh 300 udhaar")).toBe(true);
  });

  it("rejects an amount not present in the source", () => {
    expect(validateExtracted({ customerName: "Ramesh", amountPaise: 50000, entryType: "SALE", isCreditSale: true }, "Ramesh 300 udhaar")).toBe(false);
  });

  it("rejects an empty customer name", () => {
    expect(validateExtracted({ customerName: "", amountPaise: 30000, entryType: "SALE", isCreditSale: true }, "Ramesh 300 udhaar")).toBe(false);
  });
});

describe("StubLlmProvider", () => {
  it("returns a parseable JSON extraction", async () => {
    const p = new StubLlmProvider();
    const r = await p.extract({ text: "Ramesh 300 udhaar" });
    const parsed = JSON.parse(r.raw);
    expect(parsed.customerName).toBe("Ramesh");
    expect(parsed.amountPaise).toBe(30000);
  });
});

describe("LlmExtractionParser fallback", () => {
  it("falls back to deterministic when the circuit breaker is open", async () => {
    const p = new StubLlmProvider();
    const parser = new LlmExtractionParser(p, "shop", { isOpen: () => true, recordFailure: () => {}, recordSuccess: () => {} }, 1000, { callsToday: 0 });
    const r = await parser.parseAsync!("Ramesh 300 udhaar");
    expect(r?.customerName).toBe("Ramesh");
    expect(r?.amountPaise).toBe(30000);
  });

  it("falls back when the daily cap is exceeded", async () => {
    const p = new StubLlmProvider();
    const parser = new LlmExtractionParser(p, "11111111-2222-3333-4444-555555555555", { isOpen: () => false, recordFailure: () => {}, recordSuccess: () => {} }, 0, { callsToday: 0 });
    const r = await parser.parseAsync!("Ramesh 300 udhaar");
    expect(r?.customerName).toBe("Ramesh");
  });
});
