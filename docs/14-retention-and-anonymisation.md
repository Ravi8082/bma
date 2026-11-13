# 14 — Retention and anonymisation (for legal review)

**Status: proposed policy. Not legal advice. Requires review by Indian counsel before launch.**
This document satisfies the approved condition on residual risks `R-03`, `R-05` and `R-06`:
financial history is retained, personal data is minimised and anonymised, and every period below is
explicit rather than implied.

Read with `docs/07-security-privacy.md`, `docs/11-threat-model.md` (A1–A11) and
`docs/13-rls-and-roles.md`.

## 1. Principles

1. **Financial records are retained.** Ledger rows, reversals and the audit trail are not deleted on
   an erasure request; they are de-identified instead. Deleting them would destroy the seller's own
   books and our audit evidence.
2. **Personal data is minimised.** We store what the seller's business needs and no more. Phone,
   address and notes are encrypted; customer names are unencrypted by explicit decision so they stay
   searchable.
3. **Erasure means anonymisation where retention applies.** "Delete my account" removes or
   irreversibly de-identifies personal data, keeps amounts and tombstones, and records what was done.
4. **Retention is enforced by jobs, not by hope.** Every period has a scheduled, bounded job and a
   test (`DB-45`, `DB-46`). A missing job is a bug.
5. **Backups age out on their own schedule.** A backup is never edited; it expires. A restore is
   followed by re-applying outstanding erasures from the tombstone log.
6. **Legal hold overrides deletion.** A hold freezes both erasure and retention jobs for the named
   shop or records, and every hold is audited.

## 2. Retention periods (proposed)

All periods are measured from the event in the last column. "Anonymise" means the row survives with
direct identifiers removed; "delete" means the row is removed.

| Data | Asset | Period | Action at end | Clock starts |
|---|---|---|---|---|
| Ledger entries, reversals, adjustments | A1 | **8 years** | retain (statutory books); no delete path | `occurred_at` |
| Audit log | A6 | **3 years** (minimum 1) | delete in bounded batches | `created_at` |
| Security events | A6 | **1 year** | delete in bounded batches | `occurred_at` |
| Seller identity (name, encrypted phone) | A3 | account life + **90 days** | anonymise; keep user id as tombstone | closure |
| Customer name | A2 | account life + **90 days** | anonymise to `Customer <short-id>` | closure |
| Customer phone, address, notes (ciphertext + blind index) | A2 | account life + **90 days** | delete ciphertext and blind index (set `NULL`) | closure |
| Customer ledger link | A1 | with the ledger row | retain `customer_id` pointing at the anonymised row | — |
| WhatsApp message body | A4 | **90 days** | delete body; keep envelope metadata | `received_at` |
| Raw webhook payload | A4 | **30 days** | delete payload; keep hash and status | `received_at` |
| Audio / voice note | A4 | **deleted after successful transcription** | delete object; keep row with `deleted_at` | transcription |
| Images / documents | A4 | **90 days** (shop setting may shorten) | delete object | upload |
| Transcripts | A4 | **90 days** | delete | `created_at` |
| AI extraction run (redacted) | A11 | **90 days** | delete; keep aggregate counters | `created_at` |
| Cost logs (no PII) | A8 | **2 years** | delete | `created_at` |
| OTP challenges | A3 | **24 hours after expiry** | delete | `expires_at` |
| Refresh tokens | A3 | **30 days** or revocation | delete; keep session audit | `expires_at` |
| Idempotency keys | — | **24 hours** | delete | `expires_at` |
| Export files | A1/A2 | **7 days** (link lives 24 h) | delete object; keep export audit | `created_at` |
| Pending drafts | — | **30 minutes** | expire; confirmed history retained | `created_at` |
| Backups | A1–A8 | **35 days**; PITR **7 days** | expire | backup time |
| Support/admin ticket records | A6 | **3 years** | delete; keep denial audit | `created_at` |

Every period is configuration (`RETENTION_*` env or a `retention_policies` table), never a literal
inside a job. Changing a period is a reviewed change with a migration note, not a code edit buried
in a query.

## 3. Anonymisation procedure

### 3.1 Trigger

One of:

- seller requests deletion (`DELETE /api/v1/account`) and completes **step-up OTP**;
- shop is `CLOSED` for 90 days;
- legal/ops decision under the incident runbook (for example, a compromised account).

The request is recorded in `audit_logs` with actor, reason, request id and the policy version.

### 3.2 Grace period

7 days. During the grace period the seller can cancel (step-up OTP), the shop is read-only, and no
outbound message is sent. A cancellation is audited and ends the procedure.

On day 7 a job runs **inside `withTenant(shop)`** and performs the steps below in one transaction.
The job is idempotent: a second run finds the tombstone and exits.

### 3.3 Steps

1. **Freeze.** Set `shops.status = 'CLOSED'`, `subscriptions.status = 'CANCELLED'`, revoke every
   refresh token family, bump `session_epoch`, and mark the shop as `erasure_in_progress` in the
   tombstone.
2. **Delete media and exports.** Delete object-storage keys for audio, images, documents and export
   files. Verify the delete; a failed delete aborts the whole procedure and pages.
3. **Anonymise customers.** For each customer row: set `phone_enc = NULL`, `phone_bidx = NULL`,
   `address_enc = NULL`, `notes_enc = NULL`, `opted_out_at = now()`; replace `name` and
   `name_normalized` with `Customer <first 8 chars of id>`; keep `balance_paise` (it is derived and
   will be zeroed by the ledger rebuild).
4. **Anonymise users.** Set `phone_enc = NULL`, `phone_bidx = NULL`, `name = 'Deleted user'`,
   `status = 'DISABLED'`. Delete `login_index` rows for those users. Keep the user id so audit rows
   remain meaningful.
5. **Delete conversational PII.** Delete `conversation_messages.body` and `conversations.state_data`;
   set `contact_phone_enc`/`contact_phone_bidx` to `NULL`. Keep message ids and timestamps for the
   audit trail.
6. **Delete non-financial operational rows.** `idempotency_keys`, `otp_challenges`,
   `refresh_tokens`, `export_jobs` files, `pending_transactions` in `DRAFT`, `media_assets`.
7. **Keep financial rows.** `ledger_entries` is untouched: amounts, directions, posting ids,
   `occurred_at`, `created_by` (now a pseudonymous user id) and the customer id (pointing at the
   anonymised row) remain. This preserves the seller's books and our audit evidence.
8. **Tombstone.** Insert an `audit_logs` row (and a `security_events` row if the cause was
   security-related) with: shop id, policy version, counts per table, timestamp, operator id, and a
   hash of the request. The tombstone contains no PII.
9. **Verify.** Run the checks in §3.5. A failure rolls back the transaction and pages.
10. **Restore hygiene.** On any backup restore, replay the tombstone log against the restored
    database before it serves traffic.

### 3.4 What is *not* deleted, and why

| Retained | Reason |
|---|---|
| `ledger_entries` (amounts, direction, dates, posting ids) | the seller's books; statutory retention; audit evidence |
| `audit_logs` (now pseudonymous) | non-repudiation; incident response |
| `shops` row with `status = 'CLOSED'` | referential integrity and `ON DELETE RESTRICT` |
| aggregate counters and cost logs without PII | billing and abuse analytics |

### 3.5 Verification queries (run as `bma_app` in tenant context, or by the reporting role)

- zero rows in `customers` for the shop where `phone_enc IS NOT NULL` or `address_enc IS NOT NULL`
  or `notes_enc IS NOT NULL`;
- zero rows in `users` for the shop where `phone_bidx IS NOT NULL`;
- zero rows in `login_index` for the shop;
- zero `conversation_messages` with a non-null `body` for the shop;
- `ledger_entries` count and `SUM(amount_paise)` unchanged from the pre-erasure snapshot;
- an `audit_logs` tombstone exists for the shop with the expected policy version;
- a spot check that no remaining column contains a value matching the seller's phone pattern.

## 4. Retention job design

| Rule | Implementation |
|---|---|
| Bounded | `DELETE … WHERE id IN (SELECT id … LIMIT 1000)`; repeat with a delay; never one huge delete |
| Observable | rows deleted, duration, failures; a metric per table |
| Idempotent | a re-run deletes zero or more safely; no cursor state required |
| Ordered | delete children before parents where FKs require it |
| Audited | one summary audit row per run (not per row) |
| Safe | `statement_timeout` applies; a failure alerts and retries with backoff |
| Never | no retention job touches `ledger_entries` or `audit_logs` except the 3-year audit window, and that job is separately reviewed |

## 5. Legal review checklist

Counsel should confirm or amend:

1. The 8-year ledger period against the applicable books-of-account and tax rules for micro-sellers.
2. Whether invoice/tax records need a different period from ledger entries.
3. The 3-year audit-log period and the 90-day message/transcript period against DPDP purpose
   limitation and any sector rule.
4. That anonymised ledger rows are acceptable as retained "books" and that no PII is required on
   them.
5. The 7-day grace period and the notice wording in Hindi, Marathi and English.
6. Whether a customer (not the seller) can demand erasure, and how that interacts with the seller's
   books. Current design: the seller is the data fiduciary for customer data; we act as processor.
7. Backup retention (35 days) versus an erasure request that arrives after a backup was taken.
8. Cross-border transfer position for LLM/STT providers and the region choice.
9. Breach-notification timelines and the responsible-disclosure contact in `security.txt`.
10. Whether a legal hold register is required and who can authorise a hold.

## 6. Tests that enforce this document

| Test | Proves |
|---|---|
| `DB-45` | anonymisation removes direct identifiers, keeps ledger amounts and writes a tombstone |
| `DB-46` | retention jobs are bounded, respect the period, and never touch ledger/audit beyond policy |
| `SEC-11` | export includes consent records and is step-up protected |
| `SEC-09` | a restore drill compares counts and a ledger checksum, then replays tombstones |
| `DET-01`/`DET-02` | the tombstone is written in the same transaction and a failure rolls back |
