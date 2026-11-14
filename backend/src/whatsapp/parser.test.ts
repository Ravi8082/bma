import { describe, expect, it } from "vitest";
import { deterministicParser } from "./parser";

describe("parser direction and type safety", () => {
  it("Ramesh ko 500 ka flower diya -> SALE, type unclear, never PAYMENT_IN", () => {
    const r = deterministicParser.parse("Ramesh ko 500 ka flower diya");
    expect(r).not.toBeNull();
    expect(r!.entryType).toBe("SALE");
    expect(r!.typeUnclear).toBe(true);
  });

  it("Ramesh ne 500 diye -> PAYMENT_IN", () => {
    const r = deterministicParser.parse("Ramesh ne 500 diye");
    expect(r).not.toBeNull();
    expect(r!.entryType).toBe("PAYMENT_IN");
  });

  it("Ramesh ko 500 diye -> clarification (null)", () => {
    expect(deterministicParser.parse("Ramesh ko 500 diye")).toBeNull();
  });

  it("Ramesh 500 diye -> clarification (null)", () => {
    expect(deterministicParser.parse("Ramesh 500 diye")).toBeNull();
  });

  it("Ramesh 300 udhaar, 50 wapas aaye -> clarification (null)", () => {
    expect(deterministicParser.parse("Ramesh 300 udhaar, 50 wapas aaye")).toBeNull();
  });

  it("Meena 150 cash -> cash SALE", () => {
    const r = deterministicParser.parse("Meena 150 cash");
    expect(r).not.toBeNull();
    expect(r!.entryType).toBe("SALE");
    expect(r!.isCreditSale).toBe(false);
    expect(r!.typeUnclear).toBe(false);
  });

  it("handles Devanagari digits", () => {
    const r = deterministicParser.parse("Ramesh ३०० udhaar");
    expect(r).not.toBeNull();
    expect(r!.amountPaise).toBe(30000);
  });

  it("handles number words", () => {
    const r = deterministicParser.parse("Ramesh dedh sau udhaar");
    expect(r).not.toBeNull();
    expect(r!.amountPaise).toBe(15000);
  });

  it("Ramesh 300 udhaar -> credit sale", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar");
    expect(r).not.toBeNull();
    expect(r!.entryType).toBe("SALE");
    expect(r!.isCreditSale).toBe(true);
    expect(r!.typeUnclear).toBe(false);
  });
});
