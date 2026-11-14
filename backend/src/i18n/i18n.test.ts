import { describe, expect, it } from "vitest";
import { t, hasKeyParity, availableLanguages } from "./catalog";

describe("i18n catalog", () => {
  it("has key parity across all shipped languages", () => {
    expect(hasKeyParity()).toBe(true);
  });

  it("renders a known key in English", () => {
    expect(t("en", "entry.format_help")).toBe("Try: Ramesh 300 udhaar");
  });

  it("renders a known key in Hindi", () => {
    expect(t("hi", "entry.format_help")).toBe("Try karein: Ramesh 300 udhaar");
  });

  it("interpolates variables", () => {
    expect(t("en", "entry.new", { amount: "₹300", type: "udhaar", customer: "Ramesh" })).toContain("₹300");
  });

  it("falls back to English for an unknown language", () => {
    expect(t("xx", "entry.format_help")).toBe("Try: Ramesh 300 udhaar");
  });

  it("lists available languages", () => {
    expect(availableLanguages()).toContain("en");
    expect(availableLanguages()).toContain("hi");
  });
});
