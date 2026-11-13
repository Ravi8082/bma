# 10 — Audited admin bypass for cross-shop access

## Threat model

The dangerous insider is not a malicious engineer with database credentials — that person can read
anything. The realistic risk is **casual cross-shop access** by support or admin staff: opening a
seller's ledger to answer a ticket, then browsing another shop, then exporting. The control must
make every crossing deliberate, attributable and reviewable without pretending it can be prevented.

## Design

Cross-shop access is **not** a mode that disables tenant isolation. It is a **ticket**:

| Property | Rule |
|---|---|
| Granularity | exactly one `shopId` per ticket |
| Lifetime | 15 minutes (`ADMIN_TICKET_TTL_MS`), issued fresh per task |
| Reason | mandatory, trimmed, at least 10 characters, stored in the audit trail |
| Role | `ADMIN` may request `READ` or `WRITE`; `SUPPORT` is `READ` only |
| Scope | the ticket yields a `TenantContext` with `source: "ADMIN_TICKET"` and one `shopId` |
| Audit | `admin.access.granted` before the action, `admin.access.completed` or `admin.access.failed` after; denied attempts are recorded as `failed` |
| Expiry | checked at use, not at issue; a ticket cannot be refreshed implicitly |

```ts
const ticket = adminAccess.issue({
  actorId: "admin-1",
  role: "ADMIN",
  shopId,
  reason: "investigating support ticket #412 — duplicate customer merge",
});

await adminAccess.execute({ ticket, shopId, operation: "READ" }, async (ctx) => {
  // ctx.shopId is the only shop this call can reach.
  return customerRepository.findById(ctx, customerId);
});
```

## Why RLS stays on

An admin ticket **adds** a shop, it never removes the `shop_id` predicate. `withTenant()` still sets
exactly one `app.shop_id`, every shop-owned table still has `FORCE ROW LEVEL SECURITY`, and the
scoped query helpers still require a `TenantContext`. This is the central safety property: there is
no code path — admin, support, worker or script — that can run an unscoped financial query.
`execute()` refuses a missing or invalid UUID shop (`ADMIN_SHOP_REQUIRED`).

## What is denied

| Attempt | Result |
|---|---|
| ticket used for another shop | `ADMIN_SHOP_MISMATCH` |
| ticket used after 15 minutes | `ADMIN_TICKET_EXPIRED` |
| SUPPORT attempting a write | `ADMIN_WRITE_FORBIDDEN` |
| ticket without a written reason | `ADMIN_REASON_REQUIRED` |
| request without a shopId | `ADMIN_SHOP_REQUIRED` |
| unscoped query, even with a valid ticket | `RLS` returns zero rows / `42501` |

Every denied attempt is written to the audit sink **before** the error is rethrown, so probing is
visible. If the audit write fails, the request fails: an unauditable admin action is not allowed.

## Audit record shape

```json
{
  "action": "admin.access.granted",
  "ticketId": "adt_…",
  "actorId": "admin-1",
  "role": "ADMIN",
  "shopId": "…",
  "reason": "investigating support ticket #412",
  "operation": "READ",
  "at": "2026-11-13T10:00:00.000Z"
}
```

`admin.access.failed` additionally carries `error` with the denial code or the thrown error
message. Phase 2 maps this contract onto the `audit_logs` table (append-only, no delete route,
`sensitive_view: true` for cross-shop reads).

## Operational rules

- Support dashboards must call `execute()` per shop; there is no "all shops" list endpoint in the
  support surface. Platform aggregate metrics are computed by a separate, shop-anonymised job.
- Exports requested under an admin ticket are watermarked with the ticket id and audited again at
  download time.
- Ticket issuance itself is audited; a burst of tickets by one actor is an alert, not a silent
  pattern.
- No shared service account may hold `ADMIN`; tickets carry a human actor id.

## Tests

`backend/src/test/adminAccess.test.ts` covers issuance validation, TTL expiry, shop mismatch,
SUPPORT read-only, missing shop, the granted/completed/failed trail, and the denial audit.
`docs/12-security-test-plan.md` (`AUTHZ-12`, `DB-07`…`DB-24`) proves the same at the database
layer: an admin ticket still sets one `shop_id`, and RLS rejects any unscoped query.
