# 00 — Open decisions and defaults I am assuming

Per development rule 13, I will not silently assume anything that touches **money, privacy or
WhatsApp policy**. Each item below has a recommended default so we are never blocked, but the
default is not applied until you confirm or override.

Legend: **[blocking]** = Phase 1–4 cannot pass acceptance without it. **[later]** = needed before
the relevant module ships.

---

## D1 — Starting niche **[blocking]**

Recommendation: **home sellers + tiffin/mess** (pickles, cakes, tiffin, home snacks).

Why: highest message volume per rupee of revenue, strongest daily-summary habit loop, and the
prompt/vocabulary set overlaps with the milk/daily-delivery preset, so Tier 2 standing orders
reuse the same eval corpus. Presets for other niches stay in the codebase but hidden.

## D2 — GST / tax rounding **[blocking]**

Recommendation: **per-line rounding, half-up, in paise**, then invoice total = sum of rounded
lines; display rounding to the nearest rupee is presentational only.

- `taxableValue`, `taxAmount` stored per line and per document, all integer paise.
- CGST/SGST split computed from the document totals, not from each line, so the halves always
  add back to the cent: `cgst = floor(taxTotal / 2)`, `sgst = taxTotal - cgst`.
- No rounding rule is applied to a ledger amount. Ledger amounts are exact.

Alternative: per-invoice rounding (simpler, but produces line sums ≠ document total, which
sellers notice and dispute). If you prefer this, say so before Phase 1 — the money engine's
`allocateTax()` signature depends on it.

## D3 — Messaging identity **[blocking before real WhatsApp]**

Recommendation: **Option 1 (shared platform number)** for Tier 1, with `MessagingIdentity`
built as an abstraction from day one.

Consequences I will encode: every outbound customer message starts with the seller's shop name
(`Sharma Tiffin: ...`), seller name is a template variable not a hardcoded string, and the
`messagingConfigs` document carries `identityType: PLATFORM | SELLER_WABA` with a nullable
`wabaId`/`phoneNumberId` so Embedded Signup is a data migration, not a rewrite.

I will **not** claim compliance with Meta's Business Solution Terms or AI-chatbot rules. Those
must be verified against Meta's current published policy before production go-live (D9).

## D4 — Confirmation policy **[blocking]**

Recommendation: **always confirm in Tier 1**. Skip-confirmation mode is designed (flag
`autoConfirmSmallAmounts`, off, plan-gated) but not enabled for any shop until a seller has a
measured run of ≥ 50 correct confirmations and explicitly opts in.

## D5 — Voice/transcript retention **[blocking before voice ships]**

Recommendation: audio deleted immediately after transcription (default); transcript kept 90 days
then purged by a bounded retention job; both configurable per plan. Seller must be told this before
the first voice note.

## D6 — Data residency **[blocking before deploy]**

Recommendation: managed PostgreSQL 16 `ap-south-1` (Mumbai), private subnet, TLS `verify-full`,
S3-compatible storage in India
region, Redis in the same region. Note: a managed PostgreSQL 16 instance with PITR is required for
staging and production; a shared/free tier is not acceptable for financial data.

## D7 — Subscription price points and limits **[later]**

Recommendation: **zero hardcoded prices**. `plans` table + admin-editable limits. Seed data
is a migration, not a constant in code. Tell me the launch prices when you have them; until then
seed plans carry `pricePaise: 0` and `isDraft: true`.

## D8 — Payment matching in Tier 1 **[later, Tier 1 boundary]**

Recommendation: Tier 1 ships **seller-confirmed matching only** (seller says "Sharma ji ne 1800
cash diye" → draft payment → confirm). OCR/UPI-screenshot matching is Tier 2 and will not be
faked in Tier 1 (rule: no fake integrations).

## D9 — Meta policy verification **[blocking before production]**

Items that need checking against Meta's *current* published policy, not my memory:
template category rules (utility vs marketing for payment reminders), the 24-hour customer
service window mechanics, per-number messaging limits and quality ratings, AI-chatbot disclosure
requirements, and opt-in evidence requirements. I will implement the mechanism and leave a
`docs/compliance-checklist.md` with citations to be filled from Meta's live docs at go-live.

## D10 — Legal/tax posture **[blocking before public launch]**

The bot will state: record-keeping aid, not tax filing, not legal/financial advice. Privacy note
in Hindi/Marathi/English. DPDP alignment is *implemented as controls* (consent records, export,
deletion, minimisation) but **not** claimed as compliance — that needs a lawyer's review.

---

## Defaults I will apply unless you object (low-risk, reversible)

| Area | Default |
|---|---|
| Timezone | `Asia/Kolkata` for all business-day boundaries |
| Financial year | 1 April – 31 March |
| Access token TTL | 15 min; refresh 30 days, rotating, httpOnly `SameSite=Lax` |
| OTP | 6 digits, HMAC-SHA256 with a server pepper, 5 min expiry, 3 attempts, max 3 sends / 30 min / number, daily cap |
| Draft expiry | 30 min (configurable) |
| Daily summary | 20:00 IST, per-shop configurable |
| Quiet hours | 21:00–08:00 IST, no customer messages |
| Retrieval window | 24 h customer service window, tracked per conversation |
| Media cap | 16 MB image, 16 MB audio, 100 MB document (Meta limits, validated again on download) |
| Password (admin only) | Argon2id, min 12 chars + TOTP |
| Logging | phone numbers masked (`+91******3210`), no OTP/token/transcript bodies |
| Deletion | account deletion request → 7-day grace → hard delete + audit tombstone |
