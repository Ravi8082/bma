# 05 — Tier 1 build plan (and what "done" means)

One phase at a time. Each phase ends with: working code, tests green, a short explanation, and a
demonstrable flow. **I stop and wait for your approval.**

## Phase 1 — Foundation

Scope: monorepo, env config, PostgreSQL connection + transaction helper, three DB roles, RLS
policies + scoped query helpers, append-only ledger schema, shared money engine,
error/logging/request-id middleware, health endpoints, docker-compose, CI skeleton, simulator
skeleton (in-memory).

Acceptance:
- `docker compose up` gives PostgreSQL + Redis; `npm run db:migrate` applies the schema; `npm run dev:api` serves `/health/ready`.
- Money engine: integer-paise arithmetic, `allocate()` never loses a paise, GST split adds back
  exactly, `formatINR(15000000) === "₹1,50,000.00"`, safe-integer overflow throws.
- RLS test: every shop-owned table has `shop_id NOT NULL`, `ENABLE` + `FORCE ROW LEVEL SECURITY`
  and a policy; a query without `app.shop_id` returns zero rows and cannot insert.
- Append-only test: `UPDATE`, `DELETE` and `TRUNCATE` on ledger/audit rows fail with `42501`.
- Idempotency test: duplicate `(shop_id, idempotency_key)` and `(shop_id, wa_message_id)` fail.
- SQL safety test: an injection payload is bound, never concatenated; the lint rule fails a
  deliberately bad fixture.
- CI runs typecheck + lint + unit + integration + security tests on Node 22.

**No business logic yet.** This phase exists so Phase 2 cannot be built on sand.

## Phase 2 — Identity, tenants, onboarding

Scope: `shops`, `shopSettings`, `users`, `plans`, `subscriptions`, OTP + JWT rotation, RBAC,
onboarding conversation (language → shop name/category → privacy consent → examples → trial),
presets seed, feature-flag resolution.

Acceptance tests:
- The security documents 11–13 are approved before Phase 2 code starts.
- OTP request → verify → refresh → refresh-rotation → reuse-detection revokes family.
- OTP rate limit: 4th request in 30 min blocked; OTP never appears in logs.
- Phone numbers are stored encrypted with a blind index; no plaintext at rest.
- Onboarding happy path in Hindi and English via simulator produces an `ACTIVE` shop with a
  14-day trial and correct preset.
- Shop B's user gets 404 (not 403) on shop A's customer resource.
- HELPER cannot read profit/settings; OWNER can.
- Flag resolution order (kill switch > shop > plan > default) unit-tested.
- Every Phase 2 table has `shop_id NOT NULL`, RLS + `FORCE`, a policy and the role grants
  asserted by the catalog test.

## Phase 3 — WhatsApp ingest + simulator end-to-end

Scope: webhook GET/POST with signature verification, `webhookProcessingEvents` dedupe, inbound
worker, conversation + message persistence, simulator provider implementing all send methods,
outbox dispatcher, status callbacks.

Acceptance tests:
- Same `waMessageId` posted twice → one row, one job, one outbound message.
- Bad signature → 401, nothing persisted.
- Meta retry after timeout → 200, no duplicate reply.
- Simulator text round-trip: inbound → stored → outbound visible in simulator inbox.
- 24-hour service window computed and stored; template chosen when outside it.

## Phase 4 — AI extraction (text)

Scope: intent classifier, prompt registry with versions, Zod output schema, normalisation
(number words, units, relative dates, Hinglish), grounding check, confidence gating, draft
creation, clarification loop, failure path that keeps the original message.

Acceptance:
- 60+ eval cases (of the eventual 200+) pass at ≥ 95 % field accuracy for amount and intent.
- "Rahul ko 500 ka maal diya" → SALE draft ₹500, customer resolved or candidate list.
- "Rahul ko paanch sau ka maal diya" → same amount (number-word normalisation).
- "Kal Sharma ji ko 2 kg cake 1200" → date = yesterday, qty 2, amount 1200.
- Grounding: an amount not present in source or context is rejected and triggers a question.
- Malformed JSON from provider → one retry → clear seller message, nothing lost.
- Prompt version recorded on every run; accuracy report groups by prompt hash.

## Phase 5 — Draft confirmation, ledger, undo

Scope: confirm/reject, atomic posting, derived balance + cache, reversals, "undo last", "galat
entry", period-lock guard, double-tap idempotency, draft expiry.

Acceptance tests (the money suite):
- Confirm twice with same idempotency key → one posting, same response.
- Two concurrent confirms with different keys → one wins, other gets `409 DRAFT_ALREADY_POSTED`.
- Partial payment: ₹1,000 sale, ₹400 payment → balance ₹600.
- Overpayment → balance negative, flagged as credit, not clamped to zero.
- Reversal of a payment restores balance and both rows remain visible and linked.
- Locked month rejects a back-dated sale, allows an adjustment with reason.
- Nightly cache-vs-ledger reconciliation reports zero drift after 500 random operations.

## Phase 6 — Customers, aliases, promises

Scope: customer CRUD + duplicate detection + merge, seller-confirmed aliases, promise lifecycle,
promise-vs-payment checking, seller notifications.

Acceptance:
- Alias "Sharma ji" resolves only after confirmation; ambiguous alias asks instead of guessing.
- Merge consolidates balance exactly; both ledgers still readable.
- Promise never changes balance; a matched payment moves it to FULFILLED
  (PARTIALLY_FULFILLED on part-pay); missed promise notifies seller once per day, max.

## Phase 7 — Voice, summaries, reminders

Scope: audio ingest + STT adapter + transcript retention, daily 20:00 summary, reminder drafting,
approval, pre-send re-validation, quiet hours, opt-out, template usage, cost logging.

Acceptance:
- Voice note → transcript → draft, same validation path as text.
- Audio deleted after transcription by default; row records `deletedAt`.
- Summary at 20:00 IST only once per shop (distributed lock; two instances → one send).
- Reminder approved at 19:50, payment recorded at 19:55 → send cancelled with reason.
- Opted-out customer: zero outbound messages, seller told, record persists.
- Quiet hours block a scheduled send and reschedule to 08:00.

## Phase 8 — Dashboard (read-mostly) + export

Scope: React PWA: OTP login, overview widgets, customers + ledger, transactions, approvals,
promises, reports, settings, feature-gated nav. Export CSV/XLSX + full JSON backup.

Acceptance:
- PWA installable, offline shell, offline draft queued and submitted as **pending approval**.
- Approvals page confirms via the same endpoint and shows identical results to WhatsApp.
- Export contains every entry with reversal links; download link expires in 24 h; audited.
- Playwright: login → see balance → confirm draft → balance changes.

## Phase 9 — Hardening, cost control, deploy

Scope: rate limits, abuse protection, cost alerts, dead-letter replay, backup/restore drill,
staging deploy (Meta test number), docs for ops, honest limitations list.

Acceptance:
- Restore drill: backup restored into a clean DB, row counts + a checksum of ledger amounts match.
- DLQ replay processes a poisoned job without duplicating side effects.
- Cost alert fires at a configured share of plan price.
- `docs/known-limitations.md` lists what Tier 1 does not do (no OCR matching, no invoices, etc.).

---

## Working agreement

- I deliver one phase, then stop.
- Each delivery includes: what changed, how to run it, what to verify, what I did not build.
- If a rule in Sections 0–12 conflicts with something I find while building, I raise it instead
  of quietly choosing.
- Anything touching money, privacy or WhatsApp policy that is not covered by D1–D10 gets a
  question, not a default.
