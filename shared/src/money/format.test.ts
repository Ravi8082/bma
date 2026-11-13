import { describe, expect, it } from "vitest";
import { paise } from "./money";
import { formatINR, groupIndian } from "./format";

describe("groupIndian()", () => {
  it("uses the 2-2-3 Indian grouping", () => {
    expect(groupIndian("1")).toBe("1");
    expect(groupIndian("999")).toBe("999");
    expect(groupIndian("1000")).toBe("1,000");
    expect(groupIndian("123456")).toBe("1,23,456");
    expect(groupIndian("1234567")).toBe("12,34,567");
    expect(groupIndian("10000000")).toBe("1,00,00,000");
  });

  it("rejects non-digits", () => {
    expect(() => groupIndian("12,34")).toThrow();
    expect(() => groupIndian("")).toThrow();
  });
});

describe("formatINR()", () => {
  it("formats whole rupees with two decimals by default", () => {
    expect(formatINR(paise(15_000_000))).toBe("₹1,50,000.00");
    expect(formatINR(paise(50_000))).toBe("₹500.00");
    expect(formatINR(paise(0))).toBe("₹0.00");
  });

  it("formats paise correctly", () => {
    expect(formatINR(paise(5))).toBe("₹0.05");
    expect(formatINR(paise(1234))).toBe("₹12.34");
  });

  it("handles negative balances (advance / credit)", () => {
    expect(formatINR(paise(-15_000_000))).toBe("-₹1,50,000.00");
    expect(formatINR(paise(-5))).toBe("-₹0.05");
  });

  it("supports display options", () => {
    expect(formatINR(paise(15_000_000), { decimals: 0 })).toBe("₹1,50,000");
    expect(formatINR(paise(50_000), { symbol: false })).toBe("500.00");
    expect(formatINR(paise(50_000), { showPlus: true })).toBe("+₹500.00");
  });

  it("refuses non-integer paise", () => {
    expect(() => formatINR(10.5 as never)).toThrow();
  });
});
