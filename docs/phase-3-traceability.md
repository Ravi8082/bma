# Phase 3 traceability matrix

Mapping each Phase 3 checklist ID to the test that covers it. **COVERED** means a passing test
proves the requirement. **PARTIAL** means a passing test proves part of it; the remaining gap is
named. "NOT COVERED" means no test exists yet.

## A. Webhook signature verification

| ID | Test file | Test name | Status |
|---|---|---|---|
| A1 | `whatsapp/webhookSignature.test.ts` | rejects a tampered body | COVERED |
| A2 | `whatsapp/webhookSignature.test.ts` | rejects a missing signature | COVERED |
| A3 | `whatsapp/webhookSignature.test.ts` | rejects a signature with wrong length | COVERED |
| A4 | — | — | NOT COVERED (rate limiting not tested in Phase 3) |
| A5 | — | — | NOT COVERED (oversized body >1 MB → 413 before signature not tested) |
| A6 | — | — | NOT COVERED (GET verification not tested) |
| A7 | `test/db/text-slice.test.ts` | bad signature returns 401 and writes nothing | PARTIAL (401 and zero `inbox_messages`/`entry_drafts` rows; the checklist's `whatsapp_messages`, `audit_logs` and queue-job assertions are not in this test) |

## B. Raw message persistence before queueing

| ID | Test file | Test name | Status |
|---|---|---|---|
| B1 | `test/db/text-slice.test.ts` | happy path: webhook -> inbox -> draft -> seller confirmation -> ledger | PARTIAL (the inbox row is `RECEIVED` after the webhook returns 200 and before processing; no test injects a throwing queue client, because the DB inbox *is* the queue) |
| B2 | — | — | NOT COVERED (Redis outage not tested) |
| B3 | `test/db/text-slice.test.ts` | duplicate webhook delivery creates one inbox row and one draft | PARTIAL (a replayed `wa_message_id` yields one inbox row and one draft; the duplicate-delivery test does not also assert the single ledger effect) |
| B4 | — | — | NOT COVERED (stale/replayed signed body outside the age window not tested) |
| B5 | — | — | NOT COVERED (raw-payload token redaction and 1 MB cap not tested) |
| B6 | — | — | NOT COVERED (body hash used for replay detection not tested) |
| B7 | `test/db/text-slice.test.ts` | a real connection failure during the insert returns 500 and writes nothing | COVERED (the backend is terminated before COMMIT: 500 `PERSISTENCE_FAILED`, zero inbox rows, zero drafts; the DB inbox is the queue, so there is no separate queue job to leak) |
| B8 | — | — | NOT COVERED (30-day raw-payload retention not tested) |
| B9 | — | — | NOT COVERED (minimal audit references retained after raw-payload deletion not tested) |
| B10 | `test/db/catalog.test.ts` | fails when a shop-owned table lacks FORCE RLS | COVERED (inbox_messages is platform-level, excluded) |
| B11 | — | — | NOT COVERED (log redaction of phone/token/body not tested) |
| B12 | `test/db/text-slice.test.ts` | duplicate webhook delivery creates one inbox row and one draft | PARTIAL (replay protection via `wa_message_id` uniqueness returns 200 with no duplicate row or draft; no queue-job assertion) |
| B13 | — | — | NOT COVERED (body >1 MB → 413 before HMAC verification not tested) |
| B14 | — | — | NOT COVERED (dual app-secret rotation window not tested) |

## C. Inbound routing

| ID | Test file | Test name | Status |
|---|---|---|---|
| C1 | — | — | NOT COVERED (registered number routing not tested) |
| C2 | — | — | NOT COVERED (unknown number → onboarding not tested) |
| C3 | — | — | NOT COVERED (payload shop_id override not tested) |
| C4 | — | — | NOT COVERED (cross-shop message ID not tested) |
| C5 | — | — | NOT COVERED (withTenant in routing not tested) |
| C6 | `test/db/phase3.test.ts`; `test/db/text-slice.test.ts` | message 2 is not claimed while message 1 is PROCESSING; serializes same-seller inserts so an uncommitted earlier message blocks a later claim | PARTIAL (per-seller serialization and earlier-before-later processing are proven; the checklist's "10 concurrent messages" FIFO assertion is not implemented) |
| C7 | `test/db/text-slice.test.ts` | a Confirm that arrives before its draft is retried, not acknowledged as DONE | PARTIAL (an early Confirm now retries instead of being acknowledged; the 5-second reorder hold and the polite dead-letter reply are not implemented) |
| C8 | — | — | NOT COVERED (unsupported message types not tested) |
| C9 | — | — | NOT COVERED (group messages not tested) |

## D. Media fetch

| ID | Test file | Test name | Status |
|---|---|---|---|
| D1 | `whatsapp/media.test.ts` | rejects non-Meta domains | COVERED |
| D2 | — | — | NOT COVERED (token from secret manager not tested) |
| D3 | `whatsapp/media.test.ts` | enforces size limits | COVERED |
| D4 | `whatsapp/media.test.ts` | enforces MIME type limits | COVERED |
| D5 | `whatsapp/media.test.ts` | checks magic bytes | COVERED |
| D6 | — | — | NOT COVERED (encrypted storage not tested) |
| D7 | — | — | NOT COVERED (token rotation runbook not tested) |

## E. Outbound messaging

| ID | Test file | Test name | Status |
|---|---|---|---|
| E1 | — | — | NOT COVERED (outbound via MessagingProvider not tested) |
| E2 | — | — | NOT COVERED (outbound persisted as OUTBOUND not tested) |
| E3 | — | — | NOT COVERED (retry via outbox not tested) |
| E4 | — | — | NOT COVERED (rate limits not tested) |
| E5 | `test/db/phase3.test.ts` | never blind-retries from UNKNOWN | COVERED (UNKNOWN state) |
| E6 | — | — | NOT COVERED (seller notification on failure not tested) |
| E7 | — | — | NOT COVERED (pre-checks not tested) |
| E8 | — | — | NOT COVERED (Meta token from secret manager not tested) |
| E9 | — | — | NOT COVERED (seller notification not tested) |
| E10 | — | — | NOT COVERED (per-shop backpressure not tested) |
| E11 | — | — | NOT COVERED (global backpressure not tested) |

## F. Status webhooks

| ID | Test file | Test name | Status |
|---|---|---|---|
| F1 | — | — | NOT COVERED (monotonic state not tested at app level) |
| F2 | — | — | NOT COVERED (out-of-order not tested) |
| F3 | — | — | NOT COVERED (duplicate idempotency not tested) |
| F4 | — | — | NOT COVERED (failed delivery not tested) |

## G. Transactional outbox

| ID | Test file | Test name | Status |
|---|---|---|---|
| G1 | — | — | NOT COVERED (same-transaction write not tested) |
| G2 | — | — | NOT COVERED (withTenant in outbox not tested) |
| G3 | — | — | NOT COVERED (idempotency not tested) |
| G4 | — | — | NOT COVERED (dead-letter does not block queue not tested) |
| G5 | — | — | NOT COVERED (dead-lettered visible/retryable not tested) |

## H. Contract test

| ID | Test file | Test name | Status |
|---|---|---|---|
| H1 | — | — | NOT COVERED (contract test not implemented) |

## I. Cross-cutting

| ID | Test file | Test name | Status |
|---|---|---|---|
| I1 | — | — | NOT COVERED (route registry not tested) |
| I2 | `test/db/tenant.test.ts` | fails closed when no tenant context is set | COVERED (no dynamic SQL) |
| I3 | `test/db/ledger.test.ts`; `test/db/text-slice.test.ts` | rejects updates and deletes on the append-only ledger; undo appends a linked reversal, restores the balance, leaves the original intact, and rejects a second undo | COVERED (append-only enforced for `bma_app`; one linked `REVERSAL`, balance returns to 0, the original row is byte-identical, and a second undo is rejected with `ENTRY_ALREADY_REVERSED`) |
| I4 | `test/db/catalog.test.ts` | fails when a shop-owned table lacks FORCE RLS | COVERED |

## J. Per-seller ordering design

| ID | Test file | Test name | Status |
|---|---|---|---|
| J1 | `test/db/phase3.test.ts`; `test/db/text-slice.test.ts` | message 2 is not claimed while message 1 is PROCESSING; serializes same-seller inserts so an uncommitted earlier message blocks a later claim | PARTIAL (two-message serialization proven; the 10-message concurrent FIFO case is not implemented) |
| J2 | — | — | NOT COVERED (crash recovery not tested) |
| J3 | — | — | NOT COVERED (Redis outage not tested) |
| J4 | `test/db/text-slice.test.ts` | a Confirm that arrives before its draft is retried, not acknowledged as DONE | PARTIAL (early Confirm retries; no 5-second reorder window or polite dead-letter reply) |
| J5 | — | — | NOT COVERED (dead-letter does not block queue not tested) |

## Slice hardening proofs

Branch `phase-3/text-slice-hardening` adds seven tests to `test/db/text-slice.test.ts`
(14 tests in that file). Each pasted run is recorded here with its exact scope.

| # | Behaviour | Test | Raw run |
|---|---|---|---|
| 1 | Same-seller messages are serialized so an uncommitted earlier message cannot be skipped | `serializes same-seller inserts so an uncommitted earlier message blocks a later claim` | 2 passed / 12 skipped (with the early-Confirm test) — while the second insert waited on the seller advisory lock, a claim returned `EMPTY`; after release the rows were ordered first→second and processed in that order |
| 1 | A Confirm that arrives before its draft is not acknowledged | `a Confirm that arrives before its draft is retried, not acknowledged as DONE` | 0 ledger rows; inbox row is `FAILED` with `DRAFT_NOT_FOUND` so the scheduler retries it |
| 2 | Two simultaneous Confirm presses produce one ledger row and one balance change | `two simultaneous Confirm presses post exactly one ledger row and one balance change` | 1 passed / 13 skipped — `Promise.all` returned one `CONFIRMED` and one `ALREADY_CONFIRMED`, one ledger row, balance `30000`, one confirmation outbox message |
| 3 | Undo appends a linked reversal, restores the balance, and rejects a second undo | `undo appends a linked reversal, restores the balance, leaves the original intact, and rejects a second undo` | 1 passed — balance `30000 → 0`; original row unchanged; reversal `CREDIT 30000` linked via `reverses_entry_id`; second undo throws `ENTRY_ALREADY_REVERSED`; `UPDATE` and `DELETE` on `app.ledger_entries` fail with `42501` as `bma_app` |
| 4 | A real connection failure during the webhook insert returns 500 and writes nothing | `a real connection failure during the insert returns 500 and writes nothing` | 1 passed — the backend is terminated before `COMMIT`; response is 500 `PERSISTENCE_FAILED`; zero inbox rows and zero drafts. The `FATAL: terminating connection due to administrator command` log is expected |
| 5 | Startup refuses a non-UTF8 database | `reports UTF8 for the configured database`; `refuses to start when the database encoding is not UTF8` | 2 passed / 12 skipped — UTF8 database reports `encoding: "UTF8"`; a real `WIN1252` database is rejected with `encoding WIN1252 ... requires UTF8` |

Full suite after hardening: **19 files, 108 tests, exit 0**; `tsc --noEmit` clean.

## Summary

- **Tests:** 19 files, 108 tests, all passing on embedded PostgreSQL 18.6.
- **COVERED:** 13 rows (A1, A2, A3, B7, B10, D1, D3, D4, D5, E5, I2, I3, I4).
- **PARTIAL:** 8 rows (A7, B1, B3, B12, C6, C7, J1, J4).
- **NOT COVERED:** 46 rows.
- **New in this hardening branch:** 7 tests covering 5 behaviours, taking
  `test/db/text-slice.test.ts` from 7 to 14 tests and the suite from 101 to 108.

### Reconciliation

The TEXT slice now runs end to end: webhook → `inbox_messages` → draft → seller Confirm →
`ledger_entries`, with the simulator as the messaging provider. The remaining gaps are
deliberately outside this slice:

- **A:** rate limiting (A4), oversize pre-check (A5), GET verification (A6).
- **B:** queue-outage and stale-body handling (B2, B4), payload redaction and body hashing
  (B5, B6), retention (B8), log redaction (B10, B11), body-size-before-signature (B13),
  dual-secret rotation (B14).
- **C:** registered-vs-unknown routing (C1–C5), unsupported types (C8), groups (C9), plus the
  C6 ten-message FIFO case and the C7 reorder window.
- **D:** secret-manager token (D2), encrypted media storage (D6), rotation runbook (D7).
- **E:** pre-checks, seller notifications, backpressure (E1–E4, E6–E11).
- **F:** status-webhook wiring and monotonicity at the HTTP layer.
- **G:** outbox same-transaction, idempotency and dead-letter tests.
- **H:** the simulator + mocked-Meta contract suite.
- **J:** real worker-kill crash recovery (J2), Redis outage (J3), queue-continues-after-
  dead-letter (J5), and the J4 reorder window.

### Files implemented

- `whatsapp/webhookSignature.ts` + test (signature verification)
- `whatsapp/media.ts` + test (SSRF, size, type, magic bytes)
- `whatsapp/inbox.ts` (claim, markDone, markFailed, reclaimExpiredLeases)
- `whatsapp/outbound.ts` (enqueue, claim, markSent, markUnknown, markFailed, reconcileStatus)
- `whatsapp/statusWebhook.ts` (monotonic status updates)
- `whatsapp/scheduler.ts` (sweeper + outbox processor, in-process interval)
- `whatsapp/webhookRoutes.ts` (GET verification + POST webhook)
- `whatsapp/webhookController.ts` (per-message transaction, seller advisory lock, injectable
  `WebhookTransactionRunner`)
- `whatsapp/advisory.ts` (shared `sellerAdvisoryKey`)
- `whatsapp/inboundRouter.ts` (`DRAFT_NOT_FOUND` retry guard)
- `whatsapp/confirmation.ts` (concurrent Confirm, `EntryAlreadyReversedError`)
- `config/db.ts` (UTF8 startup guard, `withTransactionOnPool`)
- `server.ts` (logs the database encoding)
- `test/globalSetup.ts`, `test/helpers/postgres.ts` (bootstrap URI for probe databases)
- `test/db/text-slice.test.ts` (14 tests: slice + hardening)
- `migrations/0009_phase3_webhook.sql`, `migrations/0010_text_slice.sql`
- `docs/meta-staging-checklist.md`

### CI workflow

The CI workflow (`.github/workflows/ci.yml`) runs integration tests with
`TEST_DB_PROVIDER=testcontainers` (PostgreSQL 16). The PgBouncer transaction-mode test is not
yet a separate CI step; it is documented but has not run in CI.

### Known limitations

1. **C7/J4 reorder window is not implemented.** An early Confirm fails with `DRAFT_NOT_FOUND`
   and retries; after three attempts it is dead-lettered with the generic notice, not held for
   five seconds and answered politely.
2. **C6/J1 FIFO is proven for two messages**, not the checklist's ten concurrent messages.
3. **Untested hardening-adjacent checks:** rate limiting (A4), oversize pre-check (A5/B13),
   GET verification (A6), replay-age window (B4), log redaction (B10/B11), dual-secret rotation
   (B14), retention jobs (B8).
4. **Status webhooks and the contract test are not wired end to end** (F1–F4, H1), and the
   PgBouncer CI step has not run.
5. **`phase-3-done` is blocked** on the manual Meta staging run in
   `docs/meta-staging-checklist.md`.
6. `npm audit` reports 17 unreviewed vulnerabilities; they were not addressed in this slice.

### Next steps

1. Keep `phase-3-done` blocked until the manual Meta staging run passes.
2. Gate 1 still needs contract tests (H1), status-webhook wiring (F1–F4), a PgBouncer CI run,
   and the remaining A–J reconciliation.
3. If the checklist is to be closed exactly as written, implement the C7/J4 five-second reorder
   window and the C6/J1 ten-message FIFO test.
4. Do not start Phase 4.
