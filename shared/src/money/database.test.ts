import { describe, expect, it } from "vitest";
import { fromDatabasePaise, toDatabasePaise } from "./database";
import { MoneyError, paise } from "./money";

describe("fromDatabasePaise()", () => {
  it("accepts an exact BIGINT string", () => {
    expect(fromDatabasePaise("100000000000")).toBe(100_000_000_000);
    expect(fromDatabasePaise("0")).toBe(0);
    expect(fromDatabasePaise("-1")).toBe(-1);
  });

  it("accepts a bigint and a safe integer number", () => {
    expect(fromDatabasePaise(123_456_789n)).toBe(123_456_789);
    expect(fromDatabasePaise(42)).toBe(42);
  });

  it("rejects fractional, exponent and empty strings", () => {
    for (const value of ["10.5", "1e3", "", "  ", "12a", "+7"]) {
      expect(() => fromDatabasePaise(value)).toThrow(MoneyError);
    }
  });

  it("rejects values outside the safe integer range", () => {
    expect(() => fromDatabasePaise("9007199254740993")).toThrow(/safe integer/);
    expect(() => fromDatabasePaise("9007199254740993")).toThrow(MoneyError);
  });
});

describe("toDatabasePaise()", () => {
  it("writes a plain decimal string, never a float", () => {
    const text = toDatabasePaise(paise(100_000_000_000));
    expect(text).toBe("100000000000");
    expect(text).not.toContain(".");
    expect(text).not.toContain("e");
  });

  it("round-trips the maximum and zero", () => {
    expect(fromDatabasePaise(toDatabasePaise(paise(100_000_000_000)))).toBe(100_000_000_000);
    expect(fromDatabasePaise(toDatabasePaise(paise(0)))).toBe(0);
  });

  it("rejects a non-integer amount", () => {
    expect(() => toDatabasePaise(10.5 as never)).toThrow(MoneyError);
  });
});
