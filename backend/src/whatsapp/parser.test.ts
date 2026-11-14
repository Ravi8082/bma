import { describe, expect, it } from "vitest";
import { deterministicParser } from "./parser";

describe("parser direction and type safety", () => {
  it("Ramesh ko 500 ka flower diya -> SALE, type unclear, never PAYMENT_IN", () => {
    const r = deterministicParser.parse("Ramesh ko 500 ka flower diya");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("SALE");
    expect(r.entry.typeUnclear).toBe(true);
  });

  it("Ramesh ne 500 diye -> PAYMENT_IN", () => {
    const r = deterministicParser.parse("Ramesh ne 500 diye");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("PAYMENT_IN");
  });

  it("Ramesh ko 500 diye -> clarification", () => {
    const r = deterministicParser.parse("Ramesh ko 500 diye");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Ramesh 500 diye -> clarification", () => {
    const r = deterministicParser.parse("Ramesh 500 diye");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Ramesh 300 udhaar, 50 wapas aaye -> clarification", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar, 50 wapas aaye");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Meena 150 cash -> cash SALE", () => {
    const r = deterministicParser.parse("Meena 150 cash");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("SALE");
    expect(r.entry.isCreditSale).toBe(false);
    expect(r.entry.typeUnclear).toBe(false);
  });

  it("handles Devanagari digits", () => {
    const r = deterministicParser.parse("Ramesh ३०० udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(30000);
  });

  it("handles number words", () => {
    const r = deterministicParser.parse("Ramesh dedh sau udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(15000);
  });

  it("Ramesh 300 udhaar -> credit sale", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("SALE");
    expect(r.entry.isCreditSale).toBe(true);
    expect(r.entry.typeUnclear).toBe(false);
  });

  it("hello -> NOT_AN_ENTRY", () => {
    const r = deterministicParser.parse("hello");
    expect(r.kind).toBe("NOT_AN_ENTRY");
  });

  it("Ramesh se 500 mile -> PAYMENT_IN", () => {
    const r = deterministicParser.parse("Ramesh se 500 mile");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("PAYMENT_IN");
  });

  it("Ramesh ne 500 ka maal liya -> SALE credit", () => {
    const r = deterministicParser.parse("Ramesh ne 500 ka maal liya");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("SALE");
    expect(r.entry.isCreditSale).toBe(true);
  });

  it("रमेश ने ५०० दिले -> PAYMENT_IN", () => {
    const r = deterministicParser.parse("रमेश ने ५०० दिले");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("PAYMENT_IN");
  });

  it("रमेशला ५०० चा माल दिला -> SALE", () => {
    const r = deterministicParser.parse("रमेशला ५०० चा माल दिला");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.entryType).toBe("SALE");
  });

  it("Meena ko 500 diya -> clarification", () => {
    const r = deterministicParser.parse("Meena ko 500 diya");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });
});
