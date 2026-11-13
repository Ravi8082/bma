import { describe, expect, it } from "vitest";
import { MoneyError, paise, sum } from "./money";
import { allocate } from "./allocate";

describe("allocate()", () => {
  it("splits evenly and gives the leftover to the first line", () => {
    expect(allocate(paise(10_000), [1, 1, 1])).toEqual([3334, 3333, 3333]);
  });

  it("never loses a paise", () => {
    expect(sum(allocate(paise(1), [1, 1, 1]))).toBe(1);
    expect(allocate(paise(1), [1, 1])).toEqual([1, 0]);
    expect(allocate(paise(0), [5, 3, 2])).toEqual([0, 0, 0]);
  });

  it("respects weights", () => {
    expect(allocate(paise(1000), [1, 3])).toEqual([250, 750]);
    expect(allocate(paise(101), [1, 1])).toEqual([51, 50]);
  });

  it("handles a zero-weight line", () => {
    expect(allocate(paise(1000), [0, 1])).toEqual([0, 1000]);
  });

  it("is deterministic for equal remainders", () => {
    const first = allocate(paise(100), [3, 3, 3]);
    const second = allocate(paise(100), [3, 3, 3]);
    expect(first).toEqual(second);
    expect(first).toEqual([34, 33, 33]);
  });

  it("rejects impossible allocations", () => {
    expect(() => allocate(paise(100), [])).toThrow(MoneyError);
    expect(() => allocate(paise(100), [0, 0])).toThrow(MoneyError);
    expect(() => allocate(paise(100), [1, -1])).toThrow(MoneyError);
    expect(() => allocate(paise(-100), [1, 1])).toThrow(MoneyError);
  });

  it("holds the sum invariant over random totals and weights", () => {
    let seed = 42;
    const random = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };

    for (let run = 0; run < 250; run += 1) {
      const total = random(1_000_000);
      const count = 1 + random(8);
      const weights = Array.from({ length: count }, (_unused, index) =>
        index === 0 ? 1 + random(999) : random(1000),
      );

      const parts = allocate(paise(total), weights);
      expect(parts).toHaveLength(count);
      expect(sum(parts)).toBe(total);
      for (const part of parts) {
        expect(Number.isInteger(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("stays exact for very large totals", () => {
    const total = paise(100_000_000_000);
    const parts = allocate(total, [1, 1, 1, 1, 1, 1, 1]);
    expect(sum(parts)).toBe(total);
  });
});
