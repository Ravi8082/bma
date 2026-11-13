import { describe, expect, it } from "vitest";
import { normalisePhone, maskPhone, PhoneNormalisationError } from "./phone";

describe("phone normalisation", () => {
  const cases: Array<[string, string]> = [
    ["9876543210", "+919876543210"],
    ["+91 98765-43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["0091 9876543210", "+919876543210"],
    ["91 9876543210", "+919876543210"],
    ["+1 212 555 1234", "+12125551234"],
    ["+971 50 123 4567", "+971501234567"],
    ["(022) 2345-6789", "+912223456789"],
  ];

  for (const [input, expected] of cases) {
    it(`normalises ${JSON.stringify(input)} → ${expected}`, () => {
      expect(normalisePhone(input)).toBe(expected);
    });
  }

  it("rejects invalid numbers", () => {
    for (const input of ["12345", "abcd", "+91 1234", "1234567890123456", "९८७६५४३२१०"]) {
      expect(() => normalisePhone(input)).toThrow(PhoneNormalisationError);
    }
  });

  it("masks a phone for display", () => {
    expect(maskPhone("+919876543210")).toBe("+919******3210");
  });
});
