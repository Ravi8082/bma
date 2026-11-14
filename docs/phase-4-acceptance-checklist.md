# Phase 4 — Text and voice extraction, ledger writes

**Status: checklist awaiting approval. No Phase 4 code has been written.**
Blocked on approval of this checklist and on Phase 3 passing its own gates (tagged `phase-3-done`).

Read with `docs/11-threat-model.md`, `docs/12-security-test-plan.md`, `docs/13-rls-and-roles.md`,
and the Phase 3 acceptance checklist (`docs/phase-3-acceptance-checklist.md`).

## Scope

**In:** LLM-backed extraction behind the `EntryParser` interface (deterministic parser as
fallback); quick entry with zero follow-up questions; optional customer phone numbers and
contact-card capture; stable customer IDs with ambiguous-name handling (no auto-pick); evening
batch confirmation; a message catalog and per-language configuration for Hindi, Marathi,
English and Hinglish with a per-language test set; voice notes (download only from Meta
domains, transcribe, delete audio, cross-check amounts against the transcript, plan limits);
`cost_log` for LLM/STT spend.

**Out:** dashboard (Phase 8), customer management UI (Phase 6), payments (Phase 7), reports
(Phase 9).

## Deliverables

| Area | Files |
|---|---|
| Extraction | `whatsapp/extraction.ts` (LLM interface + deterministic fallback), `whatsapp/parser.ts` |
| Customers | `modules/customers/*` (stable IDs, ambiguous-name handling, optional phone) |
| Confirmation | `whatsapp/confirmation.ts` (evening batch), `whatsapp/eveningBatch.ts` |
| i18n | `i18n/catalog.ts`, `i18n/languages/*.json` (hi, mr, en, hinglish), `i18n/config.ts` |
| Voice | `whatsapp/voice.ts` (download, transcribe, delete, cross-check) |
| Cost | `cost_log` table + `costLog.ts` |
| Migrations | `0013_customers.sql`, `0014_cost_log.sql`, `0015_evening_batch.sql` |
| Tests | `extraction.test.ts`, `customers.test.ts`, `voice.test.ts`, `i18n.test.ts`, `eveningBatch.test.ts`, `costLog.test.ts` |

---

## A. LLM extraction interface

| # | Requirement | Acceptance test |
|---|---|---|
| A1 | `EntryParser` is an interface; the LLM implementation and the deterministic parser both implement it | Unit test swaps the parser in `InboundDeps` and gets identical downstream behaviour |
| A2 | The LLM extractor is selected by config (`LLM_PROVIDER`); `stub` returns the deterministic result | Config `stub` → deterministic parser runs; no network call |
| A3 | LLM timeout / error / malformed JSON falls back to the deterministic parser | Mock LLM throws → draft is still created from the deterministic parse; `cost_log` records the failure |
| A4 | LLM output is validated against a strict schema before use (customer name, amount, type); invalid output → fallback | Fuzzed LLM output → deterministic fallback, no partial draft |
| A5 | No customer name or amount is ever invented by the LLM; missing fields → fallback | Transcript "Ramesh udhaar" (no amount) → fallback returns null → `EXTRACTION_FAILED` |
| A6 | Extraction runs inside the worker, never on the request path; the webhook only persists | Webhook returns 200 before extraction; extraction happens in `processNextInboxMessageForShop` |

---

## B. Quick entry

| # | Requirement | Acceptance test |
|---|---|---|
| B1 | "Ramesh 300 udhaar" produces a draft with zero follow-up questions | Inbound text → one draft, one confirmation message, no clarification outbound |
| B2 | "Ramesh 300" (no keyword) defaults to a credit sale | Parsed entry type `SALE`, `is_credit_sale = true` |
| B3 | "Ramesh paid 300" / "Ramesh jama 300" produces a payment-in | Parsed entry type `PAYMENT_IN`, direction `CREDIT` |
| B4 | Amounts with rupee sign, decimals and Indian grouping parse exactly | "₹1,234.50" → `123450` paise; "1200" → `120000` paise |
| B5 | A message with no extractable customer + amount is rejected with a polite reply, no draft | "hello" → `EXTRACTION_FAILED`, dead-letter notice, zero drafts |
| B6 | Extraction latency is logged but never blocks the lease beyond the statement timeout | Test asserts processing completes within the lease window |

---

## C. Customer identity

| # | Requirement | Acceptance test |
|---|---|---|
| C1 | Customers get a stable UUID at first mention; later mentions resolve to the same ID | "Ramesh 300" then "Ramesh 200" → one customer row, two drafts, same `customer_id` |
| C2 | Name matching is normalised (case, spacing, transliteration-insensitive where configured) | "ramesh", "Ramesh ", "RAMESH" → same customer |
| C3 | An ambiguous name (two customers with the same normalised name) is never auto-picked | Two "Ramesh" customers → draft is held with `customer_id = NULL` and a clarification is sent |
| C4 | A clarification reply ("Ramesh from market" / a phone number) resolves the ambiguity | Seller replies with a disambiguator → draft is updated with the chosen customer |
| C5 | An ambiguous match that is never resolved expires with the draft TTL and notifies the seller | After `DRAFT_TTL_MINUTES` → draft expired, polite notice |
| C6 | Customers are scoped by `shop_id` and `FORCE RLS` | Cross-shop customer ID → rejected; `catalog.test.ts` covers the table |

---

## D. Optional customer phone numbers

| # | Requirement | Acceptance test |
|---|---|---|
| D1 | A customer may have zero or one phone number; the phone is optional | Customer created from "Ramesh 300" has `phone_enc = NULL` |
| D2 | A phone number can be added later via a contact card or a text reply | Inbound contact card → `customers.phone_enc` set, `phone_bidx` set |
| D3 | Contact-card capture validates the number and rejects invalid ones | Garbage contact → audit row, no update |
| D4 | Phone numbers are stored encrypted (AAD-bound) and never logged | `phone_enc` round-trips; pino output contains no phone |
| D5 | A phone number is never used as the customer key; `customer_id` is the key | Two customers sharing a phone (family) remain distinct IDs |

---

## E. Evening batch confirmation

| # | Requirement | Acceptance test |
|---|---|---|
| E1 | Drafts created during the day can be confirmed individually or held for an evening batch | A draft with `batch_pending = true` is not posted to the ledger until batch confirm |
| E2 | At the configured evening time the seller receives one batched confirmation message listing all pending drafts | Scheduler fires at `EVENING_BATCH_HOUR` → one outbound message with N entries and Confirm/Cancel buttons |
| E3 | Confirming the batch posts one ledger row per draft in one transaction | Batch confirm with 3 drafts → 3 ledger rows, 3 balance updates, one audit row |
| E4 | Cancelling the batch cancels every draft in it; partial cancel is supported per entry | Batch cancel → all drafts `CANCELLED`; a per-entry cancel button cancels only that draft |
| E5 | A batch that is never confirmed expires after `DRAFT_TTL_MINUTES` and notifies the seller | Expired batch → drafts expired, polite notice, no ledger rows |
| E6 | Evening batch runs inside `withTenant()` for the shop | Tenant context set from the batch's `shop_id` |

---

## F. Message catalog and i18n

| # | Requirement | Acceptance test |
|---|---|---|
| F1 | All seller-facing strings live in a message catalog keyed by message ID, never inline | `grep` for literal Hindi/Marathi/English sentences in `src/` returns none outside `i18n/` |
| F2 | Per-language configuration selects Hindi, Marathi, English or Hinglish per shop | `shop_settings.language = 'mr'` → Marathi strings used |
| F3 | A shop with no configured language defaults to Hinglish | Default shop → Hinglish catalog |
| F4 | Every catalog key exists in all four languages; missing key fails the build/test | Test asserts key-set parity across hi/mr/en/hinglish |
| F5 | A per-language test set exercises the parser and the catalog for each language | `i18n.test.ts` runs the same cases in all four languages and passes |
| F6 | Language can be changed by the seller via a WhatsApp command | "language hindi" → `shop_settings.language = 'hi'`, confirmation sent in Hindi |
| F7 | Numbers, currency and dates are formatted per language/locale rules | "₹300" renders correctly in all four; dates use `Asia/Kolkata` |

---

## G. Voice notes

| # | Requirement | Acceptance test |
|---|---|---|
| G1 | Voice messages are downloaded only from Meta domains (SSRF protection) | A non-Meta URL is rejected before any byte is fetched |
| G2 | Downloaded audio is transcribed by the configured STT provider | Stub STT returns a fixed transcript; LLM extraction runs on it |
| G3 | Audio is deleted from storage immediately after transcription; no audio is retained | After processing, `media_assets` row for audio is deleted; storage has no file |
| G4 | The transcribed amount is cross-checked against the parsed amount; a mismatch asks for confirmation | Transcript "Ramesh 300" but parsed "Ramesh 30" → clarification message |
| G5 | Voice notes respect plan limits (count and duration per month) | Exceeding the limit → polite refusal, no download, no transcription |
| G6 | A failed transcription is retried via the outbox and eventually dead-lettered | STT throws → message retried 3 times → dead letter + seller notice |
| G7 | Voice processing never stores the audio URL or token | `media_assets` and logs contain no URL or access token |

---

## H. Cost tracking

| # | Requirement | Acceptance test |
|---|---|---|
| H1 | Every LLM and STT call writes a row to `cost_log` with shop, provider, tokens, cost | After one extraction, `cost_log` has one row with non-null `cost_paise` |
| H2 | `cost_log` is append-only and `FORCE RLS` | `catalog.test.ts` covers the table; UPDATE/DELETE denied for `bma_app` |
| H3 | A monthly cost cap per shop pauses LLM extraction and falls back to the deterministic parser | Cap exceeded → deterministic parser used; audit row written |
| H4 | Cost is recorded even when the call fails | LLM timeout → `cost_log` row with `outcome = 'FAILED'` and `cost_paise = 0` |
| H5 | Reporting can aggregate `cost_log` by shop and month | Query returns per-shop monthly totals |

---

## I. Cross-cutting

| # | Requirement | Acceptance test |
|---|---|---|
| I1 | All extraction and customer writes run inside `withTenant()` | `check:tenant` passes |
| I2 | No dynamic SQL; all queries use the `sql` tagged template | `check:tenant` passes |
| I3 | Money stays integer paise; no floats or NUMERIC | `ledger.test.ts` invariants hold |
| I4 | No real LLM/STT credentials in tests | Tests use stub providers only |

---

## Test inventory expected

~40 new tests: A 6, B 6, C 6, D 5, E 6, F 7, G 7, H 5, I 4 (some overlap counts once).
CI gates: all pass, typecheck clean, lint clean, no skipped security test.

## Definition of done for Phase 4

All checklist items pass; a real text message and a real voice note are extracted into a
draft and confirmed into a ledger row; the evening batch works; the catalog covers all four
languages; `cost_log` records every call; then stop and wait for approval before Phase 5.
