/**
 * Minimal RBAC for Phase 2 (reduced): OWNER and HELPER only.
 *
 * Capabilities are checked server-side. A capability check is data, not code:
 * the matrix below is the single source of truth.
 */

export type Role = "OWNER" | "HELPER";

export type Capability =
  | "add_entry"
  | "view_own_customers"
  | "send_reminder"
  | "view_profit"
  | "delete_entry"
  | "change_settings"
  | "change_role"
  | "export_data"
  | "manage_helpers";

const MATRIX: Record<Role, Set<Capability>> = {
  OWNER: new Set<Capability>([
    "add_entry",
    "view_own_customers",
    "send_reminder",
    "view_profit",
    "delete_entry",
    "change_settings",
    "change_role",
    "export_data",
    "manage_helpers",
  ]),
  HELPER: new Set<Capability>([
    "add_entry",
    "view_own_customers",
    "send_reminder",
  ]),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return MATRIX[role]?.has(capability) ?? false;
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return [...(MATRIX[role] ?? [])];
}

export function isRole(value: unknown): value is Role {
  return value === "OWNER" || value === "HELPER";
}
