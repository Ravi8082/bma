import { describe, expect, it } from "vitest";
import { capabilitiesFor, hasCapability, isRole } from "./permissions";

describe("RBAC (minimal)", () => {
  it("OWNER has all capabilities", () => {
    const caps = capabilitiesFor("OWNER");
    expect(caps).toContain("add_entry");
    expect(caps).toContain("view_profit");
    expect(caps).toContain("delete_entry");
    expect(caps).toContain("change_settings");
    expect(caps).toContain("change_role");
    expect(caps).toContain("export_data");
    expect(caps).toContain("manage_helpers");
  });

  it("HELPER has limited capabilities", () => {
    const caps = capabilitiesFor("HELPER");
    expect(caps).toContain("add_entry");
    expect(caps).toContain("view_own_customers");
    expect(caps).toContain("send_reminder");
    expect(caps).not.toContain("view_profit");
    expect(caps).not.toContain("delete_entry");
    expect(caps).not.toContain("change_settings");
    expect(caps).not.toContain("change_role");
    expect(caps).not.toContain("export_data");
    expect(caps).not.toContain("manage_helpers");
  });

  it("hasCapability checks the matrix", () => {
    expect(hasCapability("OWNER", "change_role")).toBe(true);
    expect(hasCapability("HELPER", "change_role")).toBe(false);
    expect(hasCapability("HELPER", "add_entry")).toBe(true);
  });

  it("isRole validates role strings", () => {
    expect(isRole("OWNER")).toBe(true);
    expect(isRole("HELPER")).toBe(true);
    expect(isRole("ADMIN")).toBe(false);
    expect(isRole(42)).toBe(false);
  });
});
