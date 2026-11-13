import { describe, expect, it } from "vitest";
import {
  MoneyError,
  add,
  clampToEntryLimit,
  divRoundHalfUp,
  fromRupees,
  multiplyByMilli,
  neg,
  paise,
  percentOf,
  sum,
  toRupees,
} from "./index";

describe("paise()", () => {
  it("accepts integers", () => {
    expect(paise(500)).toBe(500);
    expect(paise(0)).toBe(0);
    expect(paise(-250)).toBe(-250);
  });

  it("rejects fractions, NaN and Infinity", () => {
    expect(() => paise(10.5)).toThrow(MoneyError);
    expect(() => paise(Number.NaN)).toThrow(MoneyError);
    expect(() => paise(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it("rejects values beyond the safe integer range", () => {
    expect(() => paise(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });
});

describe("fromRupees()", () => {
  it("parses Indian-grouped strings exactly", () => {
    expect(fromRupees("1,50,000.50")).toBe(15_000_050);
    expect(fromRupees("₹500")).toBe(50_000);
    expect(fromRupees(" 1,00,00,000 ")).toBe(1_000_000_000);
    expect(fromRupees("-200.25")).toBe(-20_025);
    expect(fromRupees("₹ 0.05")).toBe(5);
  });

  it("parses numbers without float drift", () => {
    expect(fromRupees(500)).toBe(50_000);
    expect(fromRupees(0.1) + fromRupees(0.2)).toBe(30);
    expect(fromRupees(-0.3)).toBe(-30);
    expect(fromRupees(0.07)).toBe(7);
  });

  it("pads a single decimal digit", () => {
    expect(fromRupees("10.5")).toBe(1050);
  });

  it("rejects malformed or over-precise input", () => {
    expect(() => fromRupees("1.234")).toThrow(MoneyError);
    expect(() => fromRupees("12abc")).toThrow(MoneyError);
    expect(() => fromRupees("")).toThrow(MoneyError);
    expect(() => fromRupees(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it("round-trips with toRupees for display", () => {
    expect(toRupees(fromRupees("1234.56"))).toBeCloseTo(1234.56, 10);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(add(paise(1), paise(2))).toBe(3);
    expect(add(paise(10), paise(-4))).toBe(6);
    expect(neg(paise(5))).toBe(-5);
    expect(sum([paise(100), paise(250), paise(-50)])).toBe(300);
  });

  it("throws instead of silently losing precision on overflow", () => {
    expect(() => add(paise(Number.MAX_SAFE_INTEGER), paise(1))).toThrow(MoneyError);
  });

  it("clamps to the per-entry limit", () => {
    expect(clampToEntryLimit(paise(100))).toBe(100);
    expect(() => clampToEntryLimit(paise(100_000_000_001))).toThrow(MoneyError);
  });
});

describe("divRoundHalfUp()", () => {
  it("rounds ties away from zero", () => {
    expect(divRoundHalfUp(5, 2)).toBe(3);
    expect(divRoundHalfUp(-5, 2)).toBe(-3);
    expect(divRoundHalfUp(1, 2)).toBe(1);
    expect(divRoundHalfUp(4, 2)).toBe(2);
    expect(divRoundHalfUp(1, 3)).toBe(0);
    expect(divRoundHalfUp(2, 3)).toBe(1);
  });

  it("rejects a zero or negative denominator", () => {
    expect(() => divRoundHalfUp(1, 0)).toThrow(MoneyError);
    expect(() => divRoundHalfUp(1, -2)).toThrow(MoneyError);
  });
});

describe("multiplyByMilli()", () => {
  it("multiplies fractional quantities without float drift", () => {
    // ₹33.33 × 2.5 kg = ₹83.325 → ₹83.33 (half-up)
    expect(multiplyByMilli(paise(3333), 2500)).toBe(8333);
    // 7 × 0.1 = 0.7 exactly
    expect(multiplyByMilli(paise(7), 100)).toBe(1);
    expect(multiplyByMilli(paise(0), 2500)).toBe(0);
  });

  it("rejects negative quantities and overflow", () => {
    expect(() => multiplyByMilli(paise(100), -1)).toThrow(MoneyError);
    expect(() => multiplyByMilli(paise(Number.MAX_SAFE_INTEGER), 2000)).toThrow(MoneyError);
  });
});

describe("percentOf()", () => {
  it("computes GST-style percentages in basis points", () => {
    expect(percentOf(paise(10_000), 1800)).toBe(1800);
    expect(percentOf(paise(999), 1800)).toBe(180);
    expect(percentOf(paise(17), 1800)).toBe(3);
    expect(percentOf(paise(1000), 250)).toBe(25);
  });

  it("rejects invalid basis points", () => {
    expect(() => percentOf(paise(100), -1)).toThrow(MoneyError);
  });
});
