# Phase 2 (Reduced) — WhatsApp onboarding, identity and tenancy

**Status: checklist awaiting approval. No Phase 2 code has been written.**
Blocked on approval of this checklist and on the Phase 1 PostgreSQL port passing its own gates
(tagged `phase-1-done`).

Read with `docs/05-tier1-plan.md` (Phase 2), `docs/02-data-model.md` (§2–3) and
`docs/13-rls-and-roles.md` (§4–8). This is a **reduced, WhatsApp-first scope**. Dashboard
authentication, refresh rotation, CSRF, cookies, step-up OTP and the admin portal are **deferred**
to the dashboard phase (Phase 8). Phase 2 exposes no endpoint that can move money.

## Scope

**In:** `shops`, `shop_settings`, `users`, `plans` (config only), `subscriptions`,
`consent_records`, `audit_logs` (Phase 1 table, first writer here), `onboarding` state machine
(resumable, idempotent on WhatsApp message ID), 13 presets as seed data only, field encryption
for phone/address/notes (key_version, separate blind-index key), minimal RBAC (OWNER, HELPER),
phone E.164 normalisation, seller identification from the WhatsApp number, export/delete requests
confirmed over WhatsApp from the registered number.

**Out (deferred to dashboard phase):** dashboard OTP login, refresh rotation, CSRF, cookies,
step-up OTP, admin portal, `otp_challenges`, `refresh_tokens`, `login_index`, `admin_users`.

## Deliverables

| Area | Files |
|---|---|
| Migrations | `backend/migrations/0006_identity_tables.sql` (tables, constraints, RLS, policies, grants), `0007_identity_indexes.sql`, `0008_presets_seed.sql` |
| Repositories | `db/repositories/shop.repository.ts`, `user.repository.ts`, `plan.repository.ts`, `subscription.repository.ts`, `consent.repository.ts`, `audit.repository.ts` — all SQL via `sql` tag + `withTenant()` |
| Services | `onboarding/onboarding.service.ts`, `onboarding/presets.ts`, `shops/shop.service.ts`, `shops/flags.service.ts`, `rbac/permissions.ts`, `crypto/fieldEncryption.ts`, `crypto/blindIndex.ts`, `crypto/phone.ts` |
| Seeds | `scripts/seed-plans.ts`, `scripts/seed-presets.ts` (data under `modules/onboarding/presets/*.json`) |
| Tests | `phone.test.ts`, `rbac.test.ts`, `onboarding.test.ts`, `consent.test.ts`, `presets.test.ts`, `flags.test.ts`, `catalog.test.ts`, `rls.test.ts`, `encryption.test.ts` |
| Webhook (Phase 3 stub) | `whatsapp/onboarding-router.ts` — routes an inbound message to the onboarding state machine when the shop is not yet `ACTIVE` |

---

## A. Phone normalisation and encryption

| # | Requirement | Acceptance test |
|---|---|---|
| A1 | Canonical form is `+<country><national>` with no spaces | `9876543210` → `+919876543210`; `+91 98765-43210` → `+919876543210` |
| A2 | Domestic prefixes normalised | `09876543210`, `0091 9876543210`, `91 9876543210` all → `+919876543210` |
| A3 | Default country is `+91` only when no `+` prefix is present | Explicit `+1…`, `+971…` preserved unchanged |
| A4 | Invalid numbers rejected with one error code | `12345`, `abcd`, `+91 1234`, 16 digits → `400 INVALID_PHONE` |
| A5 | At rest the phone is **ciphertext + blind index**, never plaintext | Raw row has `phone_enc bytea` and `phone_bidx bytea`; a full `pg_dump` contains no seller phone number |
| A6 | Blind index is deterministic and does not leak plaintext | Same normalised number → same `phone_bidx`; different number → different; the index is HMAC-SHA256 with a separate key; no plaintext index exists |
| A7 | Uniqueness is enforced on the blind index, not the ciphertext | Unique `(phone_bidx)` on `users`; creating via three formats yields one user; third attempt → `409 PHONE_ALREADY_REGISTERED` |
| A8 | Encryption is envelope AES-256-GCM with a key version | Ciphertext carries a version prefix; nonce is unique per write; a decrypt failure returns a generic error and writes a `security_events` row, never the ciphertext |
| A9 | Storage and display are separate | DB holds ciphertext only; logs use `+91******3210`; a `maskPhone()` unit test; no code path logs the decrypted value |
| A10 | Unicode digits rejected, not silently converted | `९८७६५…` → `INVALID_PHONE` |
| A11 | Normalisation is pure and tested against a 20-case table | Table-driven test with no DB |
| A12 | Seller is identified from the WhatsApp number | An inbound message from a registered number resolves to the correct shop; an unknown number starts onboarding; routing uses the blind index, never a plaintext column |

---

## B. RBAC (minimal)

| # | Requirement | Acceptance test |
|---|---|---|
| B1 | Two roles only: `OWNER` (full shop capabilities) and `HELPER` (add entries, view own customers, send reminders) | Role matrix test: 2 roles × 5 capabilities |
| B2 | OWNER has all shop capabilities | Matrix assertion |
| B3 | HELPER can add entries, cannot see profit, cannot delete, cannot change settings | `403 FORBIDDEN` per capability; the attempted call writes a denial `audit_logs` row |
| B4 | Foreign ids return **404**, not 403 | Shop B user requesting shop A's resource → 404; the same is proven at the DB layer |
| B5 | Role change is OWNER-only, audited, and notifies the owner | `audit_logs` row `user.role.change` with before/after; notification log entry |
| B6 | Permissions cannot be self-escalated | HELPER PATCHing own role → 403; a client-supplied `role`, `shopId` or `ownerId` is ignored |
| B7 | Every Phase 2 table is covered by the catalog invariants | `catalog.test.ts`: `shop_id NOT NULL`, RLS enabled + forced, policy present; `bma_app` has no `TRUNCATE`/DDL |
| B8 | A request without tenant context fails closed | An unscoped repository call returns zero rows and an insert fails with `42501` |

---

## C. Onboarding state machine (WhatsApp-first)

| # | Requirement | Acceptance test |
|---|---|---|
| C1 | Explicit states: `AWAITING_LANGUAGE → AWAITING_SHOP_NAME → AWAITING_CATEGORY → AWAITING_CONSENT → AWAITING_FIRST_ENTRY_DEMO → COMPLETE` | State transition table test, including invalid input staying in the same state |
| C2 | State is persisted per conversation and **resumable** after restart | Create state, build a fresh service instance, send the next message → continues correctly |
| C3 | Idempotent per inbound message id | Same `wa_message_id` twice → one state advance, one outbound message, one audit row (unique `(shop_id, wa_message_id)`) |
| C4 | Idempotent per onboarding step key | Re-sending the `shop` step with the same idempotency key returns the original shop; the generic `idempotency_keys` row drives it |
| C5 | Shop creation is one transaction | Force a failure after the shop insert → zero shops, zero users, zero consent rows. The shop UUID is generated in the app and `app.shop_id` is set to it, so the `WITH CHECK` passes |
| C6 | One shop per owner phone (unless multi-shop is approved) | Second onboarding from the same number resumes the existing shop, never creates a duplicate |
| C7 | Invalid input re-prompts with guidance, max 3 times then help | Empty name, 200-char name, unknown category → `ONBOARDING_INVALID_INPUT`, state unchanged |
| C8 | Language switch mid-flow keeps earlier answers | Switch hi → mr after shop name; name preserved, prompts switch |
| C9 | Unknown command never dead-ends | Sends help + 3 likely options, state unchanged |
| C10 | Trial starts from plan data, not code | Change the seeded trial days, re-run onboarding → new `trial_ends_at` follows data |
| C11 | Onboarding completion is idempotent | Second `complete` returns the same shop id, no new `shop.created` audit row |
| C12 | Onboarding is triggered by an inbound WhatsApp message from an unknown number | Webhook persists the raw message, then routes to onboarding; the state machine advances once per message ID |
| C13 | Preset selection is part of onboarding (state `AWAITING_CATEGORY`) | Seller picks a preset; `shop_settings` is written with the preset's visible modules and vocabulary hints |

---

## D. Versioned consent

| # | Requirement | Acceptance test |
|---|---|---|
| D1 | Consent row stores `purpose`, `policy_version`, `method`, `evidence_message_id`, `granted_at` | Raw row assertion; append-only (no `UPDATE` of an existing grant) |
| D2 | Policy version bump forces re-consent | Bump the version constant → the next financial action and every reminder are blocked with `CONSENT_STALE`; the onboarding flow re-prompts |
| D3 | Consent is per purpose | Withdrawing `MARKETING` keeps `BOOKKEEPING`; outbound queries filter on purpose |
| D4 | Revocation is append-only | New row with `granted = false`; the prior row is untouched |
| D5 | No consent → no non-essential processing | Onboarding works with minimal fields; nothing is sent to an LLM |
| D6 | Consent appears in the data export | Export includes all consent rows with policy versions |

---

## E. Presets are seed data only

| # | Requirement | Acceptance test |
|---|---|---|
| E1 | Presets live in JSON data files, loaded by `db:seed` | No `switch (preset)` in application code (lint/grep check in CI) |
| E2 | All 13 presets exist, including **FLOWER_SELLER** (retail + daily delivery variants) | Seed count + key list assertion |
| E3 | A preset only sets data: visible modules, vocabulary hints, default report type, template set, units | Snapshot test of `shop_settings` for two presets |
| E4 | Unknown preset key rejected at onboarding | `400 UNKNOWN_PRESET`, state unchanged; `preset_key` also has a `CHECK` |
| E5 | Preset edits are versioned | `presets_version` stored on the shop; re-seeding does not mutate existing shops |
| E6 | Every preset can complete onboarding | Loop over all 13 presets → `ACTIVE` shop, flags resolve, no exception |
| E7 | Preset cannot bypass money or permission rules | Preset onboarding attempts a ledger write → no such route exists; RBAC matrix unchanged |

---

## F. Plans, flags, subscription (config only)

| # | Requirement | Acceptance test |
|---|---|---|
| F1 | Resolution order: kill switch > shop override > plan entitlement > default | 4-case table test |
| F2 | Unknown flag name throws at registration | A typo in `requireFeature('voise')` fails at boot, not silently at runtime |
| F3 | No price or limit hardcoded | grep for `₹`/`price` in `src/` returns only seed files and formatting helpers |
| F4 | Trial expiry transition | Fake clock past `trial_ends_at` → `subscription.status = GRACE`, seller notified once, features per plan |
| F5 | Downgrade never deletes data | Subscription change leaves all rows intact; features off, data readable |
| F6 | Plan data is reference data with a version | Seeds are idempotent (`ON CONFLICT DO UPDATE` with a version); re-running does not duplicate |

---

## G. Export and delete (WhatsApp-confirmed)

| # | Requirement | Acceptance test |
|---|---|---|
| G1 | Export request is initiated over WhatsApp from the registered number | A message "export my data" from the registered number triggers an export job; the same request from an unknown number is ignored |
| G2 | Export is confirmed over WhatsApp | The seller receives a confirmation message with a one-time download link (7-day expiry); the link is single-use |
| G3 | Delete request is initiated over WhatsApp from the registered number | A message "delete my account" from the registered number starts the 7-day grace period; the same request from an unknown number is ignored |
| G4 | Delete is confirmed over WhatsApp | The seller receives a confirmation message; cancellation is possible within the grace period by replying "cancel" |
| G5 | Anonymisation runs after the grace period | After 7 days (fake clock), the anonymisation procedure from `docs/14-retention-and-anonymisation.md` executes; PII is cleared, ledger amounts retained, tombstone written |
| G6 | No export or delete action requires a dashboard | The entire flow is WhatsApp-driven; no OTP, no cookie, no CSRF token |

---

## H. Cross-cutting

| # | Requirement | Acceptance test |
|---|---|---|
| H1 | Every mutation writes an audit row in the **same transaction** | Failure injection → neither the mutation nor the audit row exists; an audit failure rolls the mutation back |
| H2 | No secrets or PII in logs | Capture output across the suite; assert no raw phone, ciphertext, blind index or policy secret |
| H3 | Generic error envelope | No stack, SQL, table name or provider text in a client response; detailed only in internal logs |
| H4 | Health and graceful shutdown survive a DB drop | `/health/ready` 503 within 2 s; the process does not crash; the pool recovers |
| H5 | Security headers | Helmet: strict CSP, HSTS (prod), `frame-ancestors 'none'`, `no-store` on authenticated responses |
| H6 | All tests run as `bma_app` against real PostgreSQL | Test harness asserts `current_user = 'bma_app'` and `rolsuper = false` before every suite |

---

## Test inventory expected

~60 new tests: A 16, B 10, C 16, D 8, E 9, F 8, G 8, H 8 (some overlap counts once).
CI gates: all pass, typecheck clean, lint clean, **no skipped security test**, catalog invariant passes.

## Decisions I need from you before coding

1. **One shop per WhatsApp number?** Recommendation: yes for Tier 1 (a seller with two shops uses two numbers). This changes C6.
2. **Trial length** — 14 days recommended; stored in the plan seed, so changeable later.
3. **Preset list** — confirm 13 including `FLOWER_SELLER` (retail + daily delivery variants) and whether "kirana" and "general store" are separate presets or one.
4. **Consent policy id** — start at `privacy-v1`, with Hindi/Marathi/English copy reviewed by you before launch.
5. **Language default** — if the first message is in Devanagari, preselect Hindi; if Latin script, ask language explicitly rather than guessing Hinglish.
6. **Export format** — JSON or PDF? Recommendation: JSON for Tier 1, PDF in the dashboard phase.
7. **Delete grace period** — 7 days recommended (matches `docs/14-retention-and-anonymisation.md`).

## Decisions resolved (simpler and safer option chosen)

1. **One shop per WhatsApp number?** → **Yes for Tier 1.** A seller with two shops uses two numbers. Simpler: avoids multi-shop routing ambiguity; safer: prevents cross-shop data leakage from a single number. Changes C6.

2. **Trial length** — 14 days, stored in the plan seed. Changeable later without code changes.

3. **Preset list** — 13 presets including `FLOWER_SELLER`; "kirana" and "general store" are separate presets. Safer: distinct vocabulary sets prevent misclassification.

4. **Consent policy id** — start at `privacy-v1`, Hindi/Marathi/English copy reviewed before launch.

5. **Language default** — if the first message is in Devanagari, preselect Hindi; if Latin script, ask language explicitly rather than guessing Hinglish. Safer: avoids silently processing in the wrong language.

6. **Export format** — JSON for Tier 1. PDF deferred to dashboard phase. Simpler: no PDF rendering dependency in Phase 2.

7. **Delete grace period** — 7 days (matches `docs/14-retention-and-anonymisation.md`). Safer: gives time to cancel accidental deletion.

## Additional tests (from approval additions)

### A. Seller identification before tenant context (SECURITY DEFINER)

| # | Requirement | Acceptance test |
|---|---|---|
| A13 | Minimal SECURITY DEFINER lookup via phone blind index returning only `shop_id`, `user_id`, `role` | Function `app.resolve_seller_by_phone(bidx bytea)` returns exactly those three columns; pinned `search_path=pg_catalog, app`; owner is `bma_migrator`; `EXECUTE` revoked from `PUBLIC`, granted to `bma_app` only |
| A14 | SECURITY DEFINER cannot be used to enumerate numbers | Calling with a non-existent blind index returns zero rows; timing is constant; no error message distinguishes "not found" from "invalid" |
| A15 | Caller rate-limits before calling | Rate-limit decision is required before the function is called; a call without a rate-limit check fails a coverage test |

### B. Concurrency and idempotency

| # | Requirement | Acceptance test |
|---|---|---|
| B9 | Concurrent first messages from one new number create exactly one shop | Two concurrent onboarding messages from the same number → one shop, one user; the unique constraint on `phone_bidx` prevents the duplicate; the second message resumes the existing shop |
| B10 | Duplicate WhatsApp message IDs never advance onboarding twice | Same `wa_message_id` sent twice → one state advance, one outbound message, one audit row (unique `(shop_id, wa_message_id)`) |
| B11 | Onboarding abuse limits: per number and global | 11 onboarding starts from one number in 1 hour → 429; global cap prevents mass account creation |
| B12 | Free-trial abuse prevention | Same blind-index phone cannot start a second trial; a recycled number after deletion waits the cooling-off period |

### C. Phone-number change over WhatsApp

| # | Requirement | Acceptance test |
|---|---|---|
| C14 | Verify the new number | Seller sends "change number to +91…" → OTP sent to the new number; verification required before the change takes effect |
| C15 | Alert the old number | The old number receives a WhatsApp notification that a change was requested |
| C16 | Cooling-off period | The change takes effect after 24 hours; during cooling-off, the seller can cancel by replying "cancel" |

### D. Export and delete (WhatsApp-confirmed)

| # | Requirement | Acceptance test |
|---|---|---|
| D7 | Export delivered only to the registered number after confirmation | Export file is sent via WhatsApp to the registered number; a request from an unregistered number is ignored |
| D8 | Export daily limit and short-lived link | Max 1 export per 24 hours per shop; download link expires in 24 hours; single-use |
| D9 | Deletion: 24–72 hour cooling-off with cancel option | Delete request starts a 48-hour cooling-off; "cancel" within the window aborts; after cooling-off, anonymisation runs |
| D10 | Financial records anonymised, not hard-deleted | After deletion, ledger amounts and tombstone remain; PII columns are cleared; retention periods listed in `docs/14-retention-and-anonymisation.md` |

### E. Helper and multi-shop

| # | Requirement | Acceptance test |
|---|---|---|
| E8 | Helper addition requires owner confirmation | Adding a HELPER sends a confirmation message to the OWNER; the HELPER is not active until the OWNER replies "confirm" |
| E9 | Rule for a number belonging to more than one shop | A number can belong to at most one shop as OWNER; as HELPER, it can serve up to 3 shops; exceeding the limit → `409 HELPER_LIMIT_EXCEEDED` |

### F. Consent and encryption

| # | Requirement | Acceptance test |
|---|---|---|
| F7 | Versioned consent re-requested when the text version changes | Bump the consent text version → the next onboarding or financial action re-prompts for consent |
| F8 | Key rotation test (`key_version`) | Rotate the field-encryption key; existing rows retain `key_version = 1`; a new write uses `key_version = 2`; a read of a `key_version = 1` row still decrypts correctly |
| F9 | All 13 presets seed | `db:seed` inserts exactly 13 presets including `FLOWER_SELLER`; re-running is idempotent; count assertion in CI |

## Money and privacy risk assessment

| Decision | Risk | Mitigation |
|---|---|---|
| SECURITY DEFINER lookup | Could enumerate phone numbers if not rate-limited | Rate limit per blind index and per IP before calling; constant-time response; no distinction between "not found" and "invalid" |
| Field encryption with key_version | Key rotation complexity; old data may use old key | Envelope encryption: data key is wrapped by KMS; rotation re-wraps the data key, not the data; `key_version` identifies the KMS key version |
| WhatsApp-confirmed export/delete | Link could be forwarded; cooling-off could be too short | Single-use short-lived link (24 h); 48-hour cooling-off with cancel; export only to registered number |
| Helper multi-shop | Cross-shop data leakage if HELPER is misconfigured | HELPER can only add entries and view own customers; cannot see profit, delete, or change settings; RLS enforces shop isolation |

None of these decisions increase money risk beyond the existing Phase 1 invariants (non-negative amounts, append-only ledger, RLS). Privacy risk is mitigated by envelope encryption, blind indexes, and the SECURITY DEFINER restrictions.

## Definition of done for Phase 2 (reduced)

All checklist items pass; no ledger route exists; the catalog invariant test covers every Phase 2 table; onboarding can be killed mid-flow and resumed; every mutation is audited in-transaction; export and delete are fully WhatsApp-driven; docs are updated with the final state diagram; then I stop and wait for approval before Phase 3.
