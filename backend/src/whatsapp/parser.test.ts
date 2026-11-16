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

describe("parser money grouping, returns, multi-entry and inline phone", () => {
  it("Ramesh 1,50,000 udhaar -> 15000000 paise (Indian grouping)", () => {
    const r = deterministicParser.parse("Ramesh 1,50,000 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(15_000_000);
    expect(r.entry.entryType).toBe("SALE");
  });

  it("Ramesh 1,23,456 udhaar -> 12345600 paise (Indian grouping)", () => {
    const r = deterministicParser.parse("Ramesh 1,23,456 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(12_345_600);
  });

  it("Ramesh ₹1,234.50 udhaar -> 123450 paise (rupee sign + decimal)", () => {
    const r = deterministicParser.parse("Ramesh ₹1,234.50 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(123_450);
  });

  it("Ramesh 1,50,000.50 udhaar -> 1500050 paise (Indian grouping + decimal)", () => {
    const r = deterministicParser.parse("Ramesh 1,50,000.50 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.amountPaise).toBe(15_000_050);
  });

  it("amount at or above the configured ceiling goes to clarification, not PARSED", () => {
    const atCeiling = deterministicParser.parse("Ramesh 1000 udhaar", { maxAmountPaise: 100_000 });
    expect(atCeiling.kind).toBe("NEEDS_CLARIFICATION");
    expect((atCeiling as { reason: string }).reason).toBe("amount_above_ceiling");

    const aboveCeiling = deterministicParser.parse("Ramesh 300 udhaar", { maxAmountPaise: 1_000 });
    expect(aboveCeiling.kind).toBe("NEEDS_CLARIFICATION");
    expect((aboveCeiling as { reason: string }).reason).toBe("amount_above_ceiling");
  });

  it("Ramesh 50 wapas aaye -> return/repay clarification with concrete options", () => {
    const r = deterministicParser.parse("Ramesh 50 wapas aaye");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
    if (r.kind !== "NEEDS_CLARIFICATION") return;
    expect(r.reason).toBe("return_or_repay");
    expect(r.options).toEqual(["goods_returned", "money_returned", "cancel"]);
  });

  it("Hindi Devanagari return wording -> clarification", () => {
    const r = deterministicParser.parse("Suresh 100 वापस आला");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Marathi Devanagari return wording -> clarification", () => {
    const r = deterministicParser.parse("Mahesh 20 परत आला");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Roman repay wording -> clarification", () => {
    const r = deterministicParser.parse("Ramesh 50 repay kar diya");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Ramesh 300 udhaar, Meena 150 cash -> MULTI with two entries", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar, Meena 150 cash");
    expect(r.kind).toBe("MULTI");
    if (r.kind !== "MULTI") return;
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]?.customerName).toBe("Ramesh");
    expect(r.entries[0]?.amountPaise).toBe(30_000);
    expect(r.entries[1]?.customerName).toBe("Meena");
    expect(r.entries[1]?.amountPaise).toBe(15_000);
  });

  it("Ramesh 300 udhaar\\nMeena 150 cash -> MULTI with two entries", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar\nMeena 150 cash");
    expect(r.kind).toBe("MULTI");
    if (r.kind !== "MULTI") return;
    expect(r.entries).toHaveLength(2);
  });

  it("Ramesh 300 udhaar aur Meena 150 cash -> MULTI with two entries", () => {
    const r = deterministicParser.parse("Ramesh 300 udhaar aur Meena 150 cash");
    expect(r.kind).toBe("MULTI");
    if (r.kind !== "MULTI") return;
    expect(r.entries).toHaveLength(2);
  });

  it("one customer + two amounts -> concrete clarification options, no use_first", () => {
    const r = deterministicParser.parse("Ramesh ko 500 ka flower diya, 200 mile");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
    if (r.kind !== "NEEDS_CLARIFICATION") return;
    expect(r.reason).toBe("multiple_amounts_same_customer");
    expect(r.options).toEqual([
      "Sale 500, received 200, balance 300",
      "Sale 200 only",
      "Cancel",
    ]);
  });

  it("Ramesh 9876543210 300 udhaar -> inline phone captured in entry", () => {
    const r = deterministicParser.parse("Ramesh 9876543210 300 udhaar");
    expect(r.kind).toBe("PARSED");
    if (r.kind !== "PARSED") return;
    expect(r.entry.customerName).toBe("Ramesh");
    expect(r.entry.amountPaise).toBe(30_000);
    expect(r.entry.sellerPhone).toBe("+919876543210");
  });

  it("Ramesh aur Suresh ko 300 udhaar -> clarification, no conjunction customer", () => {
    const r = deterministicParser.parse("Ramesh aur Suresh ko 300 udhaar");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
    if (r.kind !== "NEEDS_CLARIFICATION") return;
    expect(r.options).toEqual(["300 each", "300 total split", "Cancel"]);
  });

  it("Hindi conjunction (और) -> clarification", () => {
    const r = deterministicParser.parse("Ramesh और Suresh ko 300 udhaar");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Marathi conjunction (आणि) -> clarification", () => {
    const r = deterministicParser.parse("Ramesh आणि Suresh ko 300 udhaar");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("English and -> clarification", () => {
    const r = deterministicParser.parse("Ramesh and Suresh ko 300 udhaar");
    expect(r.kind).toBe("NEEDS_CLARIFICATION");
  });

  it("Ramesh bahar 300 udhaar is NOT treated as a return", () => {
    const r = deterministicParser.parse("Ramesh bahar 300 udhaar");
    expect(r.kind).toBe("PARSED");
  });
});
