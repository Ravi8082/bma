# Phase 2 — Identity, tenancy and onboarding

**Status: checklist awaiting approval. No Phase 2 code has been written.**
Blocked on approval of `docs/11-threat-model.md`, `docs/12-security-test-plan.md` and
`docs/13-rls-and-roles.md`, and on the Phase 1 PostgreSQL port passing its own gates.

Read with `docs/05-tier1-plan.md` (Phase 2), `docs/02-data-model.md` (§2–3) and
`docs/13-rls-and-roles.md` (§4–8).

## Scope

In: `shops`, `shop_settings`, `users`, `plans`, `subscriptions`, `consent_records`,
`otp_challenges`, `refresh_tokens`, `login_index`, `admin_users`, `audit_logs` (Phase 1 table, first
writer here); OTP + JWT; RBAC; resumable onboarding; presets seed; feature-flag resolution;
`/api/v1/auth/*`, `/api/v1/onboarding/*`, `/api/v1/shop*`, `/api/v1/admin/shops` (read-only,
ticketed).

Out: WhatsApp webhook and inbound routing (Phase 3), AI extraction (Phase 4), ledger writes and
confirmation (Phase 5), customers (Phase 6), dashboard UI (Phase 8). Phase 2 exposes no endpoint
that can move money.

## Deliverables

| Area | Files |
|---|---|
| Migrations | `backend/migrations/0006_identity_tables.sql` (tables, constraints, RLS, policies, grants, `SECURITY DEFINER` lookups), `0007_identity_indexes.sql` |
| Repositories | `db/repositories/shop.repository.ts`, `user.repository.ts`, `plan.repository.ts`, `subscription.repository.ts`, `consent.repository.ts`, `otp.repository.ts`, `token.repository.ts`, `audit.repository.ts` — all SQL via `sql` tag + `withTenant()` |
| Services | `auth/otp.service.ts`, `auth/token.service.ts`, `auth/session.service.ts`, `auth/stepUp.service.ts`, `onboarding/onboarding.service.ts`, `onboarding/presets.ts`, `shops/shop.service.ts`, `shops/flags.service.ts`, `rbac/permissions.ts`, `crypto/fieldEncryption.ts`, `crypto/blindIndex.ts` |
| Seeds | `scripts/seed-plans.ts`, `scripts/seed-presets.ts` (data under `modules/onboarding/presets/*.json`) |
| Tests | `auth.test.ts`, `otp.test.ts`, `phone.test.ts`, `rbac.test.ts`, `onboarding.test.ts`, `consent.test.ts`, `presets.test.ts`, `flags.test.ts`, `catalog.test.ts`, `rls.test.ts` |

---

## A. OTP lifecycle

| # | Requirement | Acceptance test |
|---|---|---|
| A1 | OTP is stored only as **HMAC-SHA256 with a server-side pepper**, never plaintext or a bare hash | Insert a challenge; read the row as superuser; assert no 6-digit code, assert `code_hash` is a 32-byte `bytea`, and two challenges with the same code have different hashes (challenge id mixed in) |
| A2 | Plaintext OTP never appears in logs, responses, traces or error bodies | Capture pino output and HTTP bodies across the suite; assert the code is absent; response is `{ ok: true }` only |
| A3 | Expiry after **5 minutes**, enforced at verify | Fake clock +5m1s → `OTP_EXPIRED`; the row is removed by the expiry job (bounded `DELETE`), **not** a TTL |
| A4 | Maximum **3** verification attempts | 3 wrong → `OTP_INVALID`; 4th → `OTP_ATTEMPTS_EXCEEDED`; the correct code afterwards is still rejected |
| A5 | Single use | Successful verify sets `consumed_at`; replaying the same code → `OTP_INVALID` |
| A6 | Constant-time comparison | Unit test on the compare helper (`crypto.timingSafeEqual`, length-safe, no early return) |
| A7 | Per-number limit: **3 sends / 30 min**, cooldown, daily cap | 4th `otp/request` → `429` with `Retry-After`; a resend inside the cooldown → `429`; the daily cap blocks even with a new IP |
| A8 | Per-IP limit on `/auth/otp/request` | 11 requests/min from one IP → 429; the limit is shared across two app instances (real Redis) |
| A9 | Exponential lockout per number and per IP | Repeated failures increase the lockout window; a locked number cannot be unlocked by changing IP |
| A10 | No user enumeration | Known and unknown numbers return identical status, body shape, headers and comparable timing |
| A11 | Delivery goes through `MessagingProvider` | Simulator outbox contains exactly one message; the code inside it verifies against the HMAC |
| A12 | Purpose separation | A `LOGIN` OTP cannot verify `PHONE_CHANGE`, `DELETE_ACCOUNT`, `EXPORT` or `ROLE_CHANGE` |
| A13 | Admin OTP path is impossible | Admin routes require password + TOTP; no admin phone can request a seller OTP |
| A14 | Pepper rotation invalidates outstanding OTPs | Rotate the pepper in config → every unexpired challenge fails verification; regression test |

## B. Phone normalisation, encryption and blind index

| # | Requirement | Acceptance test |
|---|---|---|
| B1 | Canonical form is `+<country><national>` with no spaces | `9876543210` → `+919876543210`; `+91 98765-43210` → `+919876543210` |
| B2 | Domestic prefixes normalised | `09876543210`, `0091 9876543210`, `91 9876543210` all → `+919876543210` |
| B3 | Default country is `+91` only when no `+` prefix is present | Explicit `+1…`, `+971…` preserved unchanged |
| B4 | Invalid numbers rejected with one error code | `12345`, `abcd`, `+91 1234`, 16 digits → `400 INVALID_PHONE` |
| B5 | At rest the phone is **ciphertext + blind index**, never plaintext | Raw row has `phone_enc bytea` and `phone_bidx bytea`; a full `pg_dump` contains no seller phone number |
| B6 | Blind index is deterministic and does not leak plaintext | Same normalised number → same `phone_bidx`; different number → different; the index is HMAC-SHA256 with a separate key; no plaintext index exists |
| B7 | Uniqueness is enforced on the blind index, not the ciphertext | Unique `(phone_bidx)` on `users` and `login_index`; creating via three formats yields one user; third attempt → `409 PHONE_ALREADY_REGISTERED` |
| B8 | Encryption is envelope AES-256-GCM with a key version | Ciphertext carries a version prefix; nonce is unique per write; a decrypt failure returns a generic error and writes a `security_events` row, never the ciphertext |
| B9 | Storage and display are separate | DB holds ciphertext only; logs use `+91******3210`; a `maskPhone()` unit test; no code path logs the decrypted value |
| B10 | Unicode digits rejected, not silently converted | `९८७६५…` → `INVALID_PHONE` (explicit decision: sellers type Latin digits on WhatsApp) |
| B11 | Normalisation is pure and tested against a 20-case table | Table-driven test with no DB |

## C. Tokens and sessions

| # | Requirement | Acceptance test |
|---|---|---|
| C1 | Access token **10–15 min** (12 min), claims `sub`, `shopId`, `role`, `ver`, `jti` | Decode + assert; a token signed with the previous secret still works during the rotation window; a wrong secret → 401 |
| C2 | Refresh token: 32 random bytes, **hashed (SHA-256)** at rest | Raw row has no plaintext; `token_hash` is 32 bytes; the raw value exists only in the cookie |
| C3 | Refresh lives only in an `httpOnly`, `Secure` (prod), `SameSite=Lax` cookie, `Path=/api/v1/auth` | `Set-Cookie` assertions; refresh response body contains no token |
| C4 | Rotation on every refresh | Refresh → new cookie; old hash marked revoked; exactly one active token in the family |
| C5 | Reuse detection revokes the whole family | Replay the previous cookie → `401 REFRESH_REUSED`; every token in the family is revoked; `security_events` row written |
| C6 | Logout revokes the family; logout-all bumps `session_epoch` | A still-valid access token is rejected on the next request (`TOKEN_STALE`) after logout-all |
| C7 | **CSRF**: same-origin `Origin` check + double-submit token on every cookie-authenticated mutation | Cross-site `Origin` → 403; missing/mismatched token → 403; a GET never mutates |
| C8 | Device list and remote logout | `GET /auth/sessions` lists masked UA/IP and `last_used_at`; `DELETE /auth/sessions/:id` revokes exactly one |
| C9 | Expired refresh tokens are removed by the expiry job | Bounded `DELETE` assertion on `expires_at`; no TTL |
| C10 | Cookies are not set on failed login or failed refresh | Assert no `Set-Cookie` on 401 |
| C11 | Step-up OTP for sensitive actions | Export, account deletion, phone change, role change, staff addition and payout/payment settings require a fresh OTP; a stale (`>5 min`) step-up is rejected |
| C12 | New-device login notifies the previous number and is rate limited | Simulator outbox gets a notice; the flow is subject to its own limit |
| C13 | No token, OTP or cookie value is logged | Capture output; assert absence; the redaction list includes `authorization`, `cookie`, `set-cookie`, `code`, `token` |

## D. RBAC and tenant isolation

| # | Requirement | Acceptance test |
|---|---|---|
| D1 | Capability matrix is data, checked server-side | Table-driven test: 6 roles × 10 capabilities (add entry, edit, delete/reverse, see profit, see all customers, send reminder, export, change settings, change role, view audit) |
| D2 | OWNER has all shop capabilities | Matrix assertion |
| D3 | HELPER can add entries, cannot see profit, cannot delete, cannot change settings | `403 FORBIDDEN` per capability; the attempted call writes a denial `audit_logs` row |
| D4 | DELIVERY is limited to delivery status + cash collection | All other capabilities 403 |
| D5 | ACCOUNTANT is read-only | Every write route 403; export allowed |
| D6 | ADMIN/SUPPORT use the ticket flow from `docs/10-admin-access.md` | SUPPORT write → `ADMIN_WRITE_FORBIDDEN`; the ticket still sets exactly one `app.shop_id`; RLS remains active |
| D7 | Foreign ids return **404**, not 403 | Shop B user requesting shop A's resource → 404; the same is proven at the DB layer (`DB-08`) |
| D8 | Feature flag does not grant permission | Flag on + role denied → 403 (flags gate availability, roles gate authority) |
| D9 | Role change is OWNER-only, audited, and notifies the owner | `audit_logs` row `user.role.change` with before/after; notification log entry |
| D10 | Permissions cannot be self-escalated | HELPER PATCHing own role → 403; a client-supplied `role`, `shopId` or `ownerId` is ignored |
| D11 | Every Phase 2 table is covered by the catalog invariants | `catalog.test.ts`: `shop_id NOT NULL`, RLS enabled + forced, policy present; `bma_app` has no `TRUNCATE`/DDL |
| D12 | A request without tenant context fails closed | An unscoped repository call returns zero rows and an insert fails with `42501` |
| D13 | Every route appears in the authz/IDOR/injection matrix | Route registry enumeration fails the build on a missing entry |

## E. Onboarding state machine

| # | Requirement | Acceptance test |
|---|---|---|
| E1 | Explicit states: `AWAITING_LANGUAGE → AWAITING_SHOP_NAME → AWAITING_CATEGORY → AWAITING_CONSENT → AWAITING_FIRST_ENTRY_DEMO → COMPLETE` | State transition table test, including invalid input staying in the same state |
| E2 | State is persisted per conversation and **resumable** after restart | Create state, build a fresh service instance, send the next message → continues correctly |
| E3 | Idempotent per inbound message id | Same `wa_message_id` twice → one state advance, one outbound message, one audit row (unique `(shop_id, wa_message_id)`) |
| E4 | Idempotent per onboarding step key | Re-sending the `shop` step with the same idempotency key returns the original shop; the generic `idempotency_keys` row drives it |
| E5 | Shop creation is one transaction | Force a failure after the shop insert → zero shops, zero users, zero consent rows. The shop UUID is generated in the app and `app.shop_id` is set to it, so the `WITH CHECK` passes |
| E6 | One shop per owner phone (unless multi-shop is approved) | Second onboarding from the same number resumes the existing shop, never creates a duplicate |
| E7 | Invalid input re-prompts with guidance, max 3 times then help | Empty name, 200-char name, unknown category → `ONBOARDING_INVALID_INPUT`, state unchanged |
| E8 | Language switch mid-flow keeps earlier answers | Switch hi → mr after shop name; name preserved, prompts switch |
| E9 | Unknown command never dead-ends | Sends help + 3 likely options, state unchanged |
| E10 | Trial starts from plan data, not code | Change the seeded trial days, re-run onboarding → new `trial_ends_at` follows data |
| E11 | Onboarding completion is idempotent | Second `complete` returns the same shop id, no new `shop.created` audit row |

## F. Versioned consent

| # | Requirement | Acceptance test |
|---|---|---|
| F1 | Consent row stores `purpose`, `policy_version`, `method`, `evidence_message_id`, `granted_at` | Raw row assertion; append-only (no `UPDATE` of an existing grant) |
| F2 | Policy version bump forces re-consent | Bump the version constant → the next financial action (Phase 5 gate) and every reminder are blocked with `CONSENT_STALE`; the dashboard shows the prompt |
| F3 | Consent is per purpose | Withdrawing `MARKETING` keeps `BOOKKEEPING`; outbound queries filter on purpose |
| F4 | Revocation is append-only | New row with `granted = false`; the prior row is untouched |
| F5 | No consent → no non-essential processing | Onboarding works with minimal fields; nothing is sent to an LLM (nothing is, in Phase 2) |
| F6 | Consent appears in the data export | Export includes all consent rows with policy versions, behind step-up OTP |

## G. Presets are seed data only

| # | Requirement | Acceptance test |
|---|---|---|
| G1 | Presets live in JSON data files, loaded by `db:seed` | No `switch (preset)` in application code (lint/grep check in CI) |
| G2 | All 13 presets exist, including **FLOWER_SELLER** (retail + daily delivery) | Seed count + key list assertion |
| G3 | A preset only sets data: visible modules, vocabulary hints, default report type, template set, units | Snapshot test of `shop_settings` for two presets |
| G4 | Unknown preset key rejected at onboarding | `400 UNKNOWN_PRESET`, state unchanged; `preset_key` also has a `CHECK` |
| G5 | Preset edits are versioned | `presets_version` stored on the shop; re-seeding does not mutate existing shops |
| G6 | Every preset can complete onboarding | Loop over all 13 presets → `ACTIVE` shop, flags resolve, no exception |
| G7 | Preset cannot bypass money or permission rules | Preset onboarding attempts a ledger write → no such route exists (Phase 2); RBAC matrix unchanged |

## H. Plans, flags, subscription

| # | Requirement | Acceptance test |
|---|---|---|
| H1 | Resolution order: kill switch > shop override > plan entitlement > default | 4-case table test |
| H2 | Unknown flag name throws at registration | A typo in `requireFeature('voise')` fails at boot, not silently at runtime |
| H3 | No price or limit hardcoded | grep for `₹`/`price` in `src/` returns only seed files and formatting helpers |
| H4 | Trial expiry transition | Fake clock past `trial_ends_at` → `subscription.status = GRACE`, seller notified once, features per plan |
| H5 | Downgrade never deletes data | Subscription change leaves all rows intact; features off, data readable |
| H6 | Plan data is reference data with a version | Seeds are idempotent (`ON CONFLICT DO UPDATE` with a version); re-running does not duplicate |

## I. Cross-cutting

| # | Requirement | Acceptance test |
|---|---|---|
| I1 | Every route validates with Zod **strict** schemas | Unknown key rejected; bad type → 400 with field path; body/array/string size caps |
| I2 | Every mutation writes an audit row in the **same transaction** | Failure injection → neither the mutation nor the audit row exists; an audit failure rolls the mutation back |
| I3 | No secrets or PII in logs | Capture output across the suite; assert no OTP, token, raw phone, ciphertext, blind index or policy secret |
| I4 | Rate limits per IP, number and shop | Exceed → 429 with `Retry-After`; Redis down → critical paths fail closed (`503`), never bypass |
| I5 | Health and graceful shutdown survive a DB drop | `/health/ready` 503 within 2 s; the process does not crash; the pool recovers |
| I6 | Generic error envelope | No stack, SQL, table name or provider text in a client response; detailed only in internal logs |
| I7 | Security headers | Helmet: strict CSP, HSTS (prod), `frame-ancestors 'none'`, `no-store` on authenticated responses |

## Test inventory expected

~80 new tests: A 20, B 16, C 18, D 20, E 14, F 8, G 9, H 8, I 10 (some overlap counts once).
CI gates: all pass, typecheck clean, lint clean, **no skipped security test**.

## Decisions I need from you before coding

1. **One shop per WhatsApp number?** Recommendation: yes for Tier 1 (a seller with two shops uses
   two numbers). This changes E6.
2. **Trial length** — 14 days recommended; stored in the plan seed, so changeable later.
3. **OTP** — 6 digits, HMAC-SHA256 with a server pepper, **5 minutes**, 3 attempts, 3 sends / 30 min,
   daily cap, exponential lockout. This supersedes the earlier Argon2id/10-minute draft. Confirm.
4. **Preset list** — confirm 13 including `FLOWER_SELLER` (retail + daily delivery variants) and
   whether "kirana" and "general store" are separate presets or one.
5. **Consent policy id** — start at `privacy-v1`, with Hindi/Marathi/English copy reviewed by you
   before launch.
6. **Language default** — if the first message is in Devanagari, preselect Hindi; if Latin script,
   ask language explicitly rather than guessing Hinglish.
7. **Step-up freshness** — a step-up OTP is valid for 5 minutes and one action. Confirm.
8. **Field-level encryption now** — phone, address and notes are encrypted in Phase 2 with blind
   indexes, rather than deferred. Confirm (also decision 3 in `docs/11-threat-model.md`).

## Definition of done for Phase 2

All checklist items pass; no ledger route exists; the RBAC matrix test is exhaustive; the catalog
invariant test covers every Phase 2 table; onboarding can be killed mid-flow and resumed; every
mutation is audited in-transaction; docs are updated with the final state diagram and the RBAC
matrix; then I stop and wait for approval before Phase 3.
