# Phase 3 — WhatsApp webhook and inbound routing

**Status: checklist awaiting approval. No Phase 3 code has been written.**
Blocked on approval of this checklist and on Phase 2 passing its own gates (tagged `phase-2-done`).

Read with `docs/11-threat-model.md` (AC-09, R-04), `docs/12-security-test-plan.md` (WH-01…WH-08),
and `docs/13-rls-and-roles.md` (§5.3).

## Scope

**In:** Webhook endpoint (`POST /webhooks/whatsapp` + `GET` verification), HMAC-SHA256 signature verification over the raw body, replay protection, persisting the raw WhatsApp message in PostgreSQL **before** queueing, inbound message routing (onboarding vs. active shop), outbound message sending via `MessagingProvider`, webhook idempotency (`wa_message_id` unique per shop), message status tracking, transactional outbox for outbound messages, media fetch with SSRF protection, status webhooks, outbound pre-checks.

**Out:** AI extraction (Phase 4), ledger writes (Phase 5), customer management (Phase 6), dashboard (Phase 8).

## Deliverables

| Area | Files |
|---|---|
| Routes | `whatsapp/webhook.routes.ts`, `whatsapp/webhook.controller.ts` |
| Services | `whatsapp/webhook.service.ts`, `whatsapp/inbound.router.ts`, `whatsapp/outbound.service.ts`, `whatsapp/message.service.ts`, `whatsapp/media.service.ts` |
| Repositories | `whatsapp/message.repository.ts`, `whatsapp/outbox.repository.ts` |
| Middleware | `middleware/webhookSignature.ts` (raw body capture) |
| Migrations | `backend/migrations/0009_webhook_tables.sql` (outbox_events, if not already present) |
| Tests | `webhook.test.ts`, `webhookSignature.test.ts`, `inboundRouter.test.ts`, `outbound.test.ts`, `replay.test.ts`, `media.test.ts`, `statusWebhook.test.ts`, `outbox.test.ts`, `contract.test.ts` |

---

## A. Webhook signature verification

| # | Requirement | Acceptance test |
|---|---|---|
| A1 | Signature is verified over the **raw** bytes with `crypto.timingSafeEqual` before JSON parsing | A tampered body with a valid signature for the original → 401; a valid body with no signature → 401 |
| A2 | Missing or invalid signature returns 401 and persists nothing | No row in `whatsapp_messages`, no queue job, no audit row |
| A3 | Signature comparison is constant-time and length-safe | Unit test on the compare helper: different lengths, early-return-free |
| A4 | Webhook is rate-limited per IP and per phone number | Exceed → 429 with `Retry-After`; the limiter degrades open on Redis loss but remains bounded by payload size and signature verification |
| A5 | Oversized body (>1 MB) rejected before signature verification | 413 with no persistence |
| A6 | **GET verification endpoint** (`GET /webhooks/whatsapp`) verifies the hub challenge | Correct verify token → 200 with challenge echo; wrong token → 403; missing params → 400 |
| A7 | **Bad signature causes zero database writes** | A request with an invalid signature → 401; assert zero rows in `whatsapp_messages`, zero rows in `audit_logs`, zero queue jobs |

---

## B. Raw message persistence before queueing

| # | Requirement | Acceptance test |
|---|---|---|
| B1 | The inbound message row (raw payload, body hash, `wa_message_id`, status `RECEIVED`) is committed **before** the queue call | Test asserts the row exists even when the queue client throws |
| B2 | If Redis is unavailable, the endpoint still returns `200` after commit | With Redis stopped: persist → return 200; when Redis returns, the sweeper processes the row exactly once |
| B3 | A Meta retry with the same `wa_message_id` is idempotent | One row, one processing job, one ledger effect |
| B4 | A stale/replayed signed body outside the allowed age window is rejected and audited | Signed body with timestamp >5 min old → 401 + `security_events` row |
| B5 | The raw payload is redacted of provider tokens and capped at 1 MB | `whatsapp_messages.raw_payload` contains no access token; body >1 MB → rejected before persistence |
| B6 | The body hash (SHA-256 of raw body) is stored and used for replay detection | Two identical bodies with different timestamps → second is rejected as replay |
| B7 | **Return 5xx if raw-message persistence fails** | Simulate a DB error during insert → endpoint returns 500; Meta retries; no partial state; no queue job enqueued |
| B8 | **Raw payload retention limit** (30 days) | Retention job deletes `raw_payload` after 30 days; message metadata (hash, status, timestamps) retained; bounded `DELETE` with `statement_timeout` |
| B9 | **RLS on the messages table** | `whatsapp_messages` has `FORCE ROW LEVEL SECURITY` and a tenant policy; a query without tenant context returns zero rows |
| B10 | **Log redaction** | No raw phone, access token, or message body in pino output; redaction list includes `authorization`, `cookie`, `set-cookie`, `access_token`, `body`, `raw_payload` |

---

## C. Inbound routing

| # | Requirement | Acceptance test |
|---|---|---|
| C1 | A message from a registered number routes to the active shop's handler | Inbound from a registered owner → `shop_id` resolved via `resolve_seller_by_phone` → message queued for processing |
| C2 | A message from an unknown number routes to onboarding | Inbound from unknown number → onboarding state machine is invoked |
| C3 | Routing resolves the shop from the shop's own phone binding, never from the payload's claimed ids | A payload claiming `shop_id = X` but sent from a number bound to shop Y → routed to Y |
| C4 | A payload whose `wa_message_id` belongs to shop A cannot be routed into shop B | Cross-shop message ID → rejected, `security_events` row |
| C5 | Routing runs inside `withTenant()` for the resolved shop | The message processor receives a tenant-scoped DB handle |
| C6 | **Per-seller ordered processing** | Queue key is `(shop_id, seller_phone_bidx)`; concurrency = 1; "Confirm" cannot run before its "Draft" is processed; a test with 10 concurrent messages verifies FIFO order |

---

## D. Media fetch

| # | Requirement | Acceptance test |
|---|---|---|
| D1 | Media is fetched **only from Meta domains** | A media URL pointing to a non-Meta domain → rejected; SSRF test with `localhost`, `127.0.0.1`, `169.254.169.254`, `file://` → all rejected |
| D2 | Fetch uses the access token from the secret manager | The token is never in the URL, never logged, never stored; it is passed as a header |
| D3 | Size limit enforced (max 16 MB for audio, 5 MB for images) | A 20 MB file → rejected with `MEDIA_TOO_LARGE`; no partial storage |
| D4 | Type limit enforced (audio: ogg/opus, mp3, wav; image: jpeg, png, webp) | An unsupported type → rejected with `MEDIA_UNSUPPORTED_TYPE` |
| D5 | Magic-byte check | A file with a `.jpg` extension but PDF magic bytes → rejected |
| D6 | Encrypted storage | Media is stored encrypted at rest (AES-256-GCM, same envelope as field encryption); `key_version` stored; no plaintext on disk |
| D7 | **Token rotation documented** | `docs/` includes a runbook for rotating the Meta access token without downtime |

---

## E. Outbound messaging

| # | Requirement | Acceptance test |
|---|---|---|
| E1 | Outbound messages go through `MessagingProvider` | Simulator outbox records the message; Meta provider calls the Graph API |
| E2 | Outbound messages are persisted in `whatsapp_messages` with direction `OUTBOUND` | Row exists with status `SENT` after successful send |
| E3 | Failed outbound messages are retried via the outbox | A failed send → outbox row with status `PENDING`; retry succeeds → status `SENT` |
| E4 | Outbound messages respect rate limits | Exceed → queued, not dropped; delivered when the window resets |
| E5 | **Outbound send states** | States: `QUEUED → SENDING → SENT → (UNKNOWN → reconciled) → FAILED`; a message in `UNKNOWN` is never blind-retried; reconciliation via status webhooks |
| E6 | **Never blind-retry from UNKNOWN** | A message stuck in `UNKNOWN` for >5 min → alert, not retry; reconciliation webhook resolves it to `SENT` or `FAILED` |
| E7 | **Outbound pre-checks (hooks)** | Before sending: opt-out check, 24-hour window or template, frequency caps, quiet hours, cost caps, balance re-check; any failure → `FAILED` with reason, no send attempted |
| E8 | **Meta token only from the secret manager** | `WHATSAPP_ACCESS_TOKEN` is loaded from the secret manager at boot; production refuses to start without it; no token in logs, error bodies, or DB |

---

## F. Status webhooks

| # | Requirement | Acceptance test |
|---|---|---|
| F1 | Status updates are monotonic | `SENT → DELIVERED → READ` only; a `DELIVERED` after `READ` is ignored |
| F2 | Out-of-order status webhooks are handled | `READ` arrives before `DELIVERED` → `READ` is applied, `DELIVERED` is ignored |
| F3 | Duplicate status webhooks are idempotent | Same status webhook twice → one state change, one audit row |
| F4 | Failed delivery status is recorded | `FAILED` status → `whatsapp_messages.status = FAILED`, `last_error` set, outbox retried |

---

## G. Transactional outbox

| # | Requirement | Acceptance test |
|---|---|---|
| G1 | Outbound messages are written to `outbox_events` in the same transaction as the business write | Failure injection → neither the business write nor the outbox row exists |
| G2 | The outbox processor runs inside `withTenant()` | Every outbox dispatch sets tenant context from the event's `shop_id` |
| G3 | Outbox events are idempotent | Same event ID processed twice → one send, one status update |
| G4 | **Dead-letter handling does not block the queue** | 3 failures → dead letter; the queue continues processing other messages; `stats().deadLetters` increments; alert is raised |
| G5 | Dead-lettered events are visible and retryable by an admin | `listDeadLetters()` returns the event; a manual retry re-enqueues it |

---

## H. Contract test

| # | Requirement | Acceptance test |
|---|---|---|
| H1 | **Contract test against simulator and Meta (mocked at HTTP layer)** | The same test suite runs against `MessagingProvider = simulator` and `MessagingProvider = meta` (with `nock`/`msw` mocking the Graph API); both pass; any provider-specific behaviour is documented |

---

## I. Cross-cutting

| # | Requirement | Acceptance test |
|---|---|---|
| I1 | Webhook endpoint is registered in the route registry with authz/IDOR entries | Route enumeration test passes |
| I2 | No raw SQL outside `src/db/**` | `check:tenant` and ESLint rule pass |
| I3 | All Phase 1 and Phase 2 invariants preserved | RLS, append-only ledger, `withTenant`, no dynamic SQL all verified |
| I4 | Catalog invariant covers all shop-owned tables including new ones | `catalog.test.ts` passes |

---

## Test inventory expected

~50 new tests: A 7, B 10, C 6, D 7, E 8, F 4, G 5, H 1, I 4 (some overlap counts once).
CI gates: all pass, typecheck clean, lint clean, **no skipped security test**.

## Definition of done for Phase 3

All checklist items pass; a real WhatsApp message can be received and persisted; the raw message survives a Redis outage; onboarding is triggered for unknown numbers; outbound messages are sent and tracked; media is fetched securely; status webhooks reconcile delivery state; then I stop and wait for approval before Phase 4.
