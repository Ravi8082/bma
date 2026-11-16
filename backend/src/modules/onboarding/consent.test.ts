import { describe, expect, it } from "vitest";
import { needsReconsent, CURRENT_CONSENT_VERSION } from "./consent";

describe("consent versioning", () => {
  it("treats privacy-v1 as needing re-consent", () => {
    expect(needsReconsent("privacy-v1")).toBe(true);
  });

  it("does not re-request when already on the current version", () => {
    expect(needsReconsent(CURRENT_CONSENT_VERSION)).toBe(false);
  });

  it("re-requests when no consent record exists", () => {
    expect(needsReconsent(null)).toBe(true);
    expect(needsReconsent(undefined)).toBe(true);
  });

  it("bumps the version to privacy-v2", () => {
    expect(CURRENT_CONSENT_VERSION).toBe("privacy-v3");
  });
});
