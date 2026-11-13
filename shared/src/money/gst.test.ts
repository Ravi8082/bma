import { describe, expect, it } from "vitest";
import { paise, sum } from "./money";
import { computeDocumentTax, computeLineTax } from "./gst";

describe("computeLineTax()", () => {
  it("computes 18% in paise", () => {
    expect(computeLineTax(paise(10_000), 1800)).toBe(1800);
  });

  it("rounds half-up, not banker's rounding", () => {
    // 999 × 18% = 179.82 → 180
    expect(computeLineTax(paise(999), 1800)).toBe(180);
    // 25 × 18% = 4.5 exactly → 5
    expect(computeLineTax(paise(25), 1800)).toBe(5);
  });

  it("rejects negative taxable amounts and bad rates", () => {
    expect(() => computeLineTax(paise(-1), 1800)).toThrow();
    expect(() => computeLineTax(paise(100), -1)).toThrow();
    expect(() => computeLineTax(paise(100), 10_001)).toThrow();
  });
});

describe("computeDocumentTax() — PER_LINE", () => {
  it("sums independently rounded lines and splits CGST/SGST", () => {
    const result = computeDocumentTax(
      [
        { key: "a", taxablePaise: paise(10_000), rateBasisPoints: 1800 },
        { key: "b", taxablePaise: paise(10_000), rateBasisPoints: 1800 },
      ],
      { rounding: "PER_LINE", interState: false },
    );

    expect(result.taxableTotalPaise).toBe(20_000);
    expect(result.taxTotalPaise).toBe(3600);
    expect(result.cgstPaise).toBe(1800);
    expect(result.sgstPaise).toBe(1800);
    expect(result.igstPaise).toBe(0);
    expect(result.grandTotalPaise).toBe(23_600);
  });

  it("gives the odd paise to SGST so the halves always add back", () => {
    const result = computeDocumentTax(
      [{ key: "a", taxablePaise: paise(17), rateBasisPoints: 1800 }],
      { rounding: "PER_LINE", interState: false },
    );

    expect(result.taxTotalPaise).toBe(3);
    expect(result.cgstPaise).toBe(2);
    expect(result.sgstPaise).toBe(1);
    expect(result.cgstPaise + result.sgstPaise).toBe(result.taxTotalPaise);
  });

  it("uses IGST for inter-state supply", () => {
    const result = computeDocumentTax(
      [{ key: "a", taxablePaise: paise(10_000), rateBasisPoints: 1800 }],
      { rounding: "PER_LINE", interState: true },
    );

    expect(result.igstPaise).toBe(1800);
    expect(result.cgstPaise).toBe(0);
    expect(result.sgstPaise).toBe(0);
  });
});

describe("computeDocumentTax() — PER_INVOICE", () => {
  it("computes tax once per rate group and attributes it to lines", () => {
    const result = computeDocumentTax(
      [
        { key: "a", taxablePaise: paise(333), rateBasisPoints: 1800 },
        { key: "b", taxablePaise: paise(333), rateBasisPoints: 1800 },
        { key: "c", taxablePaise: paise(333), rateBasisPoints: 1800 },
      ],
      { rounding: "PER_INVOICE", interState: false },
    );

    // 999 × 18% = 179.82 → 180, allocated across equal lines.
    expect(result.taxTotalPaise).toBe(180);
    expect(result.lines.map((line) => line.taxPaise)).toEqual([60, 60, 60]);
    expect(sum(result.lines.map((line) => line.taxPaise))).toBe(180);
  });

  it("keeps rate groups separate", () => {
    const result = computeDocumentTax(
      [
        { key: "a", taxablePaise: paise(1000), rateBasisPoints: 500 },
        { key: "b", taxablePaise: paise(1000), rateBasisPoints: 1800 },
      ],
      { rounding: "PER_INVOICE", interState: false },
    );

    expect(result.lines.find((line) => line.key === "a")?.taxPaise).toBe(50);
    expect(result.lines.find((line) => line.key === "b")?.taxPaise).toBe(180);
    expect(result.taxTotalPaise).toBe(230);
  });
});

describe("document totals", () => {
  it("grand total equals taxable plus tax, always", () => {
    const result = computeDocumentTax(
      [
        { key: "a", taxablePaise: paise(12_345), rateBasisPoints: 500 },
        { key: "b", taxablePaise: paise(67_890), rateBasisPoints: 1200 },
        { key: "c", taxablePaise: paise(1), rateBasisPoints: 1800 },
      ],
      { rounding: "PER_LINE", interState: false },
    );

    expect(result.grandTotalPaise).toBe(result.taxableTotalPaise + result.taxTotalPaise);
    expect(result.cgstPaise + result.sgstPaise).toBe(result.taxTotalPaise);
  });

  it("handles an empty document", () => {
    const result = computeDocumentTax([], { rounding: "PER_LINE", interState: false });
    expect(result.grandTotalPaise).toBe(0);
    expect(result.lines).toEqual([]);
  });
});
