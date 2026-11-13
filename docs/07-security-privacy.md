# 07 — Security, privacy and abuse defence

> This is the summary. The authoritative threat model is [11-threat-model.md](11-threat-model.md),
> the test plan is [12-security-test-plan.md](12-security-test-plan.md), and the RLS/role design is
> [13-rls-and-roles.md](13-rls-and-roles.md).

## Tenant isolation

- `shop_id` originates **only** from a verified JWT or, for webhooks, from the resolved
  `shops`/`users` record keyed by the sender's WhatsApp number.
- Every shop-owned table has `shop_id NOT NULL`, RLS enabled **and forced**, and a policy on
  `shop_id = app.current_shop_id()`. A missing `SET LOCAL app.shop_id` fails closed (zero rows,
  insert rejected).
- Scoped query helpers require a `TenantContext`; values are bound, identifiers are allowlisted.
  Unscoped SQL is a lint/CI failure, not a review comment.
- `findById(ctx, id)` returns `null` for a foreign id; controllers map that to **404**, not 403
  (no existence oracle). Cross-row references use composite `(shop_id, other_id)` foreign keys.
- Cross-tenant admin access requires a time-boxed, reason-required ticket for exactly one shop;
  RLS remains active and every grant/completion/failure is audited.
- The runtime role is `NOSUPERUSER`, `NOBYPASSRLS`, cannot DDL, cannot `TRUNCATE`, and cannot
  become the migrator.

## Identity & sessions

- Sellers: phone + WhatsApp OTP. No passwords, ever.
- Admin/support: password + TOTP; separate login route with its own rate limit and lockout.
- Access tokens 15 min, `HS256` with a rotated secret (`JWT_SECRET_CURRENT`/`_PREVIOUS` so
  rotation doesn't log everyone out). Refresh tokens: 32 random bytes, hashed at rest, rotating,
  family-tracked; reuse revokes the family and audits.
- `sessionEpoch` claim invalidates tokens on role change, phone change, logout-all.
- OTP: HMAC-SHA256 with a server pepper, 5 min, 3 attempts, resend cooldown, per-number and
  per-IP caps, daily cap, exponential lockout, constant-time compare, generic responses,
  **never logged**. A 6-digit code is low entropy; the pepper is in the secret manager and rotation
  invalidates all outstanding OTPs.

## Input & transport

- Zod at every boundary; body size limits; JSON parse errors mapped to 400.
- Webhook: raw bytes captured before any parser, HMAC-SHA256 verified with `timingSafeEqual`,
  1 MB cap, timestamp tolerance applied to the payload's own timestamps via dedupe (Meta does not
  sign timestamps separately).
- Rate limits: auth 10/min/IP, OTP per phone, writes 120/min/shop, simulator dev-only.
- Helmet, strict CORS allowlist, `Secure` cookies, no `eval`, CSP for the PWA.

## Prompt-injection defence

1. Source text is untrusted data, wrapped in delimiters with an explicit system instruction.
2. The model has no tools, no DB access, no network.
3. Output must match a closed Zod schema; unknown keys rejected.
4. Numbers must be grounded in source/context; otherwise clarification.
5. Even a fully "successful" injection can only create a **draft a human must confirm**.
6. Every confirmation shows the amount and customer name back to the seller.
7. Adversarial corpus runs in CI (see 06).

## Money-specific safety

- Integer paise, `BIGINT` + `CHECK` in PostgreSQL, `Number.isSafeInteger` guards in the shared
  engine, max amount `₹10,00,00,000` per entry (configurable).
- Confirmation re-reads the draft inside the transaction; the UI/WhatsApp cannot change the amount
  between draft and post (version check).
- Idempotency keys on confirm/send/export.
- Period locks; reversals only, never deletes; nightly ledger-vs-cache reconciliation job.

## Logging & redaction

Pino redaction paths: `req.headers.authorization`, `req.headers.cookie`, `*.password`,
`*.code`, `*.otp`, `*.token`, `*.transcript`, `*.phoneE164` → masked `+91******3210`.
No full provider payloads in logs; `conversationMessages.payload` is stored with tokens stripped.
Transcripts are business data: retained per policy, excluded from error reports.

## Privacy (DPDP-aligned controls, not a compliance claim)

| Control | Implementation |
|---|---|
| Notice & consent | plain-language note in hi/mr/en at onboarding; `consentRecords` with policy version and evidence message id |
| Purpose limitation | separate consent purposes (bookkeeping, reminders, marketing, voice) |
| Data minimisation | only name, phone, address if the seller needs delivery, notes; no email for sellers |
| Access & portability | `/exports` full JSON + XLSX, self-service from chat |
| Correction | `/account` and ledger edit-by-reversal |
| Erasure | `/account/delete-request` → step-up OTP → 7-day grace → anonymise PII, retain financial rows and an audit tombstone (amounts only, no PII), per legal retention. Full procedure: [14-retention-and-anonymisation.md](14-retention-and-anonymisation.md) |
| Retention | per [14-retention-and-anonymisation.md](14-retention-and-anonymisation.md): audio deleted post-transcription; transcripts 90 d; webhook payloads 30 d; ledger 8 y; audit 3 y |
| Security | encryption at rest (PostgreSQL + bucket SSE), TLS in transit, field-level encryption for phone/address/notes with blind indexes, secrets in a secret manager |
| Children / sensitive data | not collected; UPI PIN/card/OTP requests are explicitly refused by the bot's copy |

We store **no** UPI PIN, card number, CVV, bank password or Aadhaar. The bot's system prompt
forbids asking for them, and a keyword guard blocks replies that would.

## Abuse

- Unknown numbers: onboarding only, no data access, rate-limited, blocked after repeated junk.
- Media caps + MIME sniffing + no execution of documents.
- Spam/forwarded-chain detection: length, repeated identical text across senders (hash) → low
  priority, seller told "yeh forwarded lagta hai".
- Support staff: masked PII, time-boxed elevation with reason, all views audited.

## Honest limitations to publish in `docs/known-limitations.md`

- Not a substitute for a CA; GST output is record-keeping only.
- No guarantee of WhatsApp delivery; Meta quality rating can throttle the number.
- LLM extraction is probabilistic: every financial record is human-confirmed by design.
- Tier 1 matching relies on seller confirmation; OCR matching is Tier 2.
- No multi-currency, no card payments, no fund custody.
