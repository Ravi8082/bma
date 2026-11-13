# 03 — API surface (Tier 1)

Base: `/api/v1`. JSON only. All timestamps ISO-8601 UTC; the API accepts `businessDate`
(`YYYY-MM-DD`) for financial fields and resolves it in the shop's timezone.

## Response envelope

```jsonc
// success
{ "ok": true, "data": { ... }, "meta": { "requestId": "..." } }
// list
{ "ok": true, "data": [ ... ], "meta": { "nextCursor": "eyJ...", "hasMore": true } }
// error
{ "ok": false, "error": { "code": "DRAFT_EXPIRED", "message": "Yeh entry purani ho gayi. Dobara bhejiye.",
  "messageKey": "draft.expired", "details": { "draftId": "..." } } }
```

Errors carry a translation key so the WhatsApp layer can render the seller's language; the
`message` is the English fallback. Never leak stack traces or provider payloads.

## Auth

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/otp/request` | `{ phoneE164, purpose }` → sends OTP via WhatsApp; always 202 (no user enumeration) |
| POST | `/auth/otp/verify` | `{ phoneE164, code, purpose }` → access token (body) + refresh cookie |
| POST | `/auth/refresh` | rotates refresh cookie, returns new access token |
| POST | `/auth/logout` | revokes current session family |
| POST | `/auth/logout-all` | revokes every device |
| GET | `/auth/sessions` | device list (ip/ua masked, last used) |
| DELETE | `/auth/sessions/:id` | remote logout |
| POST | `/auth/admin/login` | password + TOTP (separate rate-limit bucket) |

- Access token: 15 min, `Authorization: Bearer`, claims `{ sub, shopId, role, ver }`.
- Refresh: `httpOnly; Secure; SameSite=Lax; Path=/api/v1/auth` — never localStorage.
- OTP: 6 digits, HMAC-SHA256 with a server pepper at rest, 5 min expiry, 3 attempts, 3 sends / 30 min, constant-time
  compare, generic failure message.
- `ver` claim = `users.sessionEpoch`; bumping it (role change, phone change, logout-all) instantly
  invalidates live access tokens on the next request.

## Onboarding

| Method | Path | Purpose |
|---|---|---|
| GET | `/onboarding/state` | resume-point for the chat-driven flow |
| POST | `/onboarding/language` | `{ language }` |
| POST | `/onboarding/shop` | `{ shopName, category, presetKey }` → creates shop, owner user, trial |
| POST | `/onboarding/consent` | `{ privacyPolicyVersion, accepted }` → writes `consentRecords` |
| POST | `/onboarding/complete` | marks `ACTIVE`, seeds templates + preset vocabulary |

Onboarding is driven from WhatsApp, so these endpoints exist mainly for the dashboard resume path
and are exercised by the simulator scenario tests.

## Shops & settings

`GET /shop` · `PATCH /shop` (name, language, category — audited) · `GET /shop/settings` ·
`PATCH /shop/settings` (validated by a per-key Zod map; money/reminder/messaging keys require
OWNER and are audited with before/after) · `POST /shop/feature-flags/preview`
(`{ flag }` → allowed?, source of decision).

## Customers

| Method | Path | Notes |
|---|---|---|
| GET | `/customers?q=&cursor=&limit=` | search by normalized name, alias, or last-4 digits of phone |
| POST | `/customers` | duplicate check → `409 CUSTOMER_DUPLICATE` with candidates |
| GET | `/customers/:id` | |
| PATCH | `/customers/:id` | requires `version`; `409 STALE_WRITE` on mismatch |
| GET | `/customers/:id/ledger?from=&to=&cursor=` | entries + opening/closing balance |
| POST | `/customers/:id/aliases` | seller-confirmed alias only |
| DELETE | `/customers/:id/aliases/:aliasId` | |
| POST | `/customers/merge` | OWNER only, `{ sourceId, targetId, version }`, transactional |
| POST | `/customers/:id/opt-out` | records opt-out + consent revocation |
| GET | `/customers/:id/statement.pdf` | Tier 1: server-rendered, audited |

## Transactions (the core)

| Method | Path | Notes |
|---|---|---|
| GET | `/transactions/pending` | drafts awaiting confirmation, oldest first |
| GET | `/transactions/pending/:id` | includes `version`, `expiresAt`, `confidence` |
| POST | `/transactions/pending` | dashboard-created draft (same validation as WhatsApp path) |
| PATCH | `/transactions/pending/:id` | edit draft fields, requires `version` |
| POST | `/transactions/pending/:id/confirm` | `{ version, idempotencyKey }` → posts ledger atomically |
| POST | `/transactions/pending/:id/reject` | `{ version, reason? }` |
| POST | `/transactions/pending/:id/clarify` | answers a pending clarification question |
| GET | `/transactions?from=&to=&customerId=&category=&cursor=` | posted entries |
| GET | `/transactions/:id` | entry + reversal chain |
| POST | `/transactions/:id/reverse` | `{ reason, idempotencyKey }` → reversal entry, never a delete |
| GET | `/transactions/export?format=csv|xlsx` | creates an `exportJobs` row, returns job id |

Confirm semantics:
- Runs in one PostgreSQL transaction: re-read draft `FOR UPDATE` (or version check) → verify
  period lock → insert ledger entries → update `customers.balancePaise` → mark draft `CONFIRMED`
  → write audit → insert outbox event.
- Replay with the same `idempotencyKey` returns the original result with `200`.
- Expired draft → `410 DRAFT_EXPIRED`; the WhatsApp layer replies "Yeh entry purani ho gayi,
  dobara bhejiye" and keeps the original message available for one-tap resend.
- Amount change between draft and confirm is rejected (`409 DRAFT_MODIFIED`) — edits go through
  `PATCH` and re-validate.

## Promises

`POST /promises` · `GET /promises?status=&from=&to=` · `GET /promises/:id` ·
`PATCH /promises/:id` (date/amount, requires version) · `POST /promises/:id/cancel` ·
`POST /promises/:id/fulfil` (`{ paymentId }` or manual). Status transitions are validated by a
state machine; a promise in `MISSED` can be re-activated or cancelled, never silently deleted.

## Reminders

`GET /reminders?status=` · `POST /reminders` (draft, never auto-sends) ·
`POST /reminders/:id/approve` · `POST /reminders/:id/cancel` ·
`GET /reminders/preview?customerId=` (rendered text + template name + estimated cost).
`approve` stores the approver and a snapshot of the amount; the send worker re-validates before
dispatch (see 02 §5).

## Reports / memory

| Method | Path | Notes |
|---|---|---|
| GET | `/reports/daily?date=` | sales, collections, expenses, cash in hand, pending approvals |
| GET | `/reports/summary?from=&to=&groupBy=day|customer|category` | |
| POST | `/memory/ask` | `{ question }` → answer + `sources[]` (entry ids). Same retrieval path as WhatsApp; returns data, never an LLM opinion |
| GET | `/memory/customer/:id/context` | what the bot knows: aliases, last 5 entries, promises |

Every report response includes `asOf` and `sources` metadata so the dashboard can show
"data se: 12 entries" rather than a fabricated number.

## Exports, subscription, account

`POST /exports` · `GET /exports/:id` · `GET /exports/:id/download` (signed, 24 h, audited) ·
`GET /subscription` · `POST /subscription/upgrade-intent` (returns a UPI link in chat — no card
data ever touches our servers) · `POST /account/delete-request` (7-day grace, owner OTP confirm).

## Webhooks (unversioned, outside `/api/v1`)

| Method | Path | Notes |
|---|---|---|
| GET | `/webhooks/whatsapp` | `hub.mode/hub.verify_token/hub.challenge`, constant-time token compare |
| POST | `/webhooks/whatsapp` | raw body, `X-Hub-Signature-256` verified over exact bytes, 200 within 2 s |

The POST handler does exactly four things: verify signature → insert `webhookProcessingEvents`
(unique on `waMessageId`) → enqueue → 200. No DB reads of business data, no LLM, no formatting.

Signature verification covers `sha256=HMAC(appSecret, rawBody)` with `crypto.timingSafeEqual` on
equal-length buffers, and rejects bodies > 1 MB before parsing.

## Simulator (dev/test only, hard-disabled when `NODE_ENV=production`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/simulator/inbound/text` | simulate a seller text → runs the real ingest pipeline |
| POST | `/simulator/inbound/audio` | upload a file, fake a media id |
| POST | `/simulator/inbound/image` | |
| POST | `/simulator/inbound/button` | simulate an interactive reply (confirm/edit/cancel) |
| POST | `/simulator/inbound/status` | delivered/read/failed |
| GET | `/simulator/outbox?phone=` | messages the "provider" would have sent |
| POST | `/simulator/reset` | wipe simulator state (test DB only) |
| POST | `/simulator/clock` | advance a fake clock for scheduler tests |

Plus `npm run sim -- "Rahul ko 500 ka maal diya"` CLI that prints the outbound reply and the
draft JSON. The simulator is a **provider implementation**, not a mock of our own code: the same
handlers, queues and DB writes run as in production. Only the HTTP hop to Meta is replaced.

## Admin (separate cookie audience, minimal in Tier 1)

`GET /admin/shops` · `GET /admin/shops/:id` (audited, reason required) ·
`GET /admin/jobs/failed` · `POST /admin/jobs/:id/replay` · `GET /admin/flags` ·
`PATCH /admin/shops/:id/flags` · `GET /admin/costs?from=&to=` · `GET /admin/audit?actor=&action=`.
Support users get read-only, masked access and every view writes `sensitiveView: true`.

## Cross-cutting rules

- **Validation:** every route has a Zod schema for `body`, `query`, `params`; the parsed value is
  the only thing services receive. Unknown keys are stripped, not ignored silently.
- **Pagination:** cursor-based (`createdAt` + `_id`), max `limit=100`.
- **Rate limits:** per IP for auth/simulator, per shop for writes (120/min), per phone for OTP.
- **Idempotency:** writes that create money or messages require `Idempotency-Key`; the header is
  hashed with the body and replayed results are returned verbatim.
- **Audit:** every mutating route writes an `auditLogs` row inside the same transaction.
- **Health:** `GET /health` (liveness), `GET /health/ready` (PostgreSQL ping + Redis ping + queue depth).
