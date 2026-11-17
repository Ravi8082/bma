# IP and licensing record

Technical audit record. Not legal advice. Facts are from the repository; items that could not be verified are marked **UNKNOWN**.

## 1. Repository and license

- Repository: `business-memory-ai` (workspaces `shared`, `backend`, `frontend`).
- No `LICENSE` file present; all four `package.json` files declare no `license` field (npm reports `UNLICENSED`).
- Full dependency list and licenses: `docs/third-party-licenses.md` (515 distinct packages, all permissive; see that file for the full table).

## 2. Dependencies and license flags

See `docs/third-party-licenses.md`. No copyleft (GPL/AGPL/LGPL/SSPL) or unknown-license third-party package was found in `node_modules`. Flagged items requiring review: none among third-party packages. The project's own packages are `UNLICENSED` (see above).

## 3. Copied code

Search performed across the repository (excluding `node_modules` and `package-lock.json`) for `Copyright`, `SPDX`, `Licensed under`, `License:`, and URLs to Stack Overflow / GitHub / blogs.

Result: no matches in source, migrations, docs, or templates. No copied-code blocks identified. (UNKNOWN whether any code was adapted from external sources without such markers.)

## 4. Non-code assets

| Asset | Location | Source / license |
|---|---|---|
| Business-type preset JSON (bakery, electrician, flower_seller, general_store, kirana, laundry, pharmacy, plumber, salon, stationery, tailor, tiffin_service, tutor) | `backend/src/modules/onboarding/presets/*.json` | Authored in-repo (inferred); license UNKNOWN (no provenance metadata) |
| i18n catalogs (en, hi) | `backend/src/i18n/languages/*.json` | Authored in-repo (inferred); license UNKNOWN |
| Eval cases / holdout | `backend/src/eval/cases.json`, `holdout.json`, `holdout.meta.json` | Authored in-repo (inferred); license UNKNOWN |
| Evening summary template text | `docs/templates/evening-summary.md` | Authored in-repo (inferred); license UNKNOWN |
| Fonts | none found | n/a |
| Icons / images | none found | n/a |
| Sample data | none (test DB seeded at runtime) | n/a |

## 5. Git history

- Distinct authors/emails: `Ravi <palravi1093@gmail.com>` (single author).
- First commit: `2026-11-13 14:50:02 +0530`
- Last commit: `2026-11-17 12:08:35 +0530`
- Total commits: 28.

Secrets / personal data check:

- Searched for API keys, tokens, passwords, phone numbers, and real customer names in source, fixtures, and eval files.
- Only dev-only defaults (`dev-app-password`, `dev-verify-token`, `test-app-secret`, etc.) and the canonical placeholder phone `+919876543210` / `+919999999999` appear. No real seller data or production credentials found. (UNKNOWN whether any historical commit (pre-squash) contained secrets; only current HEAD history was scanned.)

## 6. AI usage record (to be completed by owner)

| Field | Value |
|---|---|
| Tool / model used | UNKNOWN (fill in: e.g. Claude, GPT, Copilot, Cursor, etc.) |
| Plan (free/paid) | UNKNOWN |
| Dates used | UNKNOWN |
| Terms of Service link | UNKNOWN (fill in URL) |
| Date ToS were read | UNKNOWN |
| Data-use / privacy policy link | UNKNOWN (fill in URL) |
| Date policy was read | UNKNOWN |
| Training on my data: on or off | UNKNOWN |
| Whether prompts/code were sent to the provider | UNKNOWN |
| Whether output was reviewed before commit | UNKNOWN |

Note: this repository was authored with AI assistance; the exact tool, plan, and dates are not recorded in the repo and must be verified by the owner. No terms-of-service content has been summarized here.

## 7. Data flows to third parties

| Service | Where in code | Data sent | Consent disclosure |
|---|---|---|---|
| WhatsApp Cloud API (Meta) | `backend/src/integrations/messaging/meta.ts`, `backend/src/whatsapp/webhookController.ts`, `webhookSignature.ts`, `media.ts` | Outbound messages (text, buttons, lists, templates), recipient phone (encrypted at rest, decrypted in process), media URLs | Consent text (`backend/src/modules/onboarding/consent.ts`) covers message processing for bookkeeping; evening summary templates disclosed. UNKNOWN whether Meta's own data use is separately disclosed to sellers. |
| LLM provider (stub/openai) | `backend/src/whatsapp/extraction.ts` (`LlmProvider`), `backend/src/config/env.ts` (`LLM_PROVIDER`, `LLM_API_KEY`) | Redacted message text (phone-like digit runs removed), customer names; no phone numbers, addresses, or ledger data | Consent text states message text including customer names is processed by a third-party language-model provider; phone numbers, addresses and ledger data are never sent. |
| Speech-to-text (stub/whisper) | `backend/src/config/env.ts` (`STT_PROVIDER`, `STT_API_KEY`) | Voice audio (when implemented) | UNKNOWN (no consent text references voice transcription specifically) |
| PostgreSQL (database) | `backend/src/config/db.ts`, `globalSetup.ts` | All application data (tenant-isolated via RLS) | Internal infrastructure, not a third party in the consent sense. |
| Redis | `backend/src/config/env.ts` (`REDIS_URL`) | Queue/session data (when bullmq driver used) | Internal infrastructure. |
| Embedded Postgres (tests only) | `backend/src/test/globalSetup.ts` | Test data only | Not production. |

No payment provider, object storage, or monitoring/SaaS SDK is wired in the code (UNKNOWN whether planned).

## 8. Name and brand check inputs

- Product name used in code/docs: "Business Memory AI" (`README.md`, `backend/src/config/db.ts` error message).
- Platform name referenced: "WhatsApp" / "WhatsApp Cloud API" (numerous files; trademark of Meta Platforms, Inc.).
- Internal application name: "bma" / "bma-api" / "bma-app" (database roles, application_name).
- Competitor names: none found in code or docs.
- Logos: none found in repository (no image assets).

## 9. Package install scripts

Packages that run install/postinstall/preinstall scripts (from `node_modules`):

- `@embedded-postgres/windows-x64@18.6.0-beta.19`: `node scripts/hydrate-symlinks.js`
- `esbuild@0.27.7`, `0.28.2`, `0.21.5`: `node install.js`
- `ssh2@1.17.0`: `node install.js`

Recently published (last 14 days, checked via `npm view`): none of the above -- `@embedded-postgres/windows-x64@18.6.0-beta.19` published 2026-10-30 (18 days before this audit). A full sweep of all 515 packages was not performed (UNKNOWN whether any other dependency was published within the last 14 days).

## 10. Verification

- Tests: 275 passed / 275, 40 files.
- `tsc --noEmit`: exit 0.
- `eslint .`: exit 0.
- `check:tenant`: exit 0.
- Commit and push result: see Batch 1 commit `a65a10f` pushed to `origin/phase-3/text-slice-hardening`.
ï»¿## 11. Asset provenance (resolved)

## 11. Asset provenance (resolved)

All four UNKNOWN entries from the previous audit resolve to in-repo authorship by the sole contributor `Ravi <palravi1093@gmail.com>` (verified via `git log -1 --format="%an <%ae>"` on each file). No third-party content, clip art, or external datasets were identified.

| Asset | Last commit author | Date | Source/ownership | License status |
|---|---|---|---|---|
| `backend/src/modules/onboarding/presets/*.json` (14 files) | Ravi | 2026-11-13 | Authored in-repo | UNKNOWN (no declared license on the repo) |
| `backend/src/i18n/languages/en.json`, `hi.json` | Ravi | 2026-11-14 | Authored in-repo | UNKNOWN |
| `backend/src/eval/cases.json`, `holdout.json`, `holdout.meta.json` | Ravi | 2026-11-16 | Authored in-repo (synthetic) | UNKNOWN |
| `docs/templates/evening-summary.md` | Ravi | 2026-11-16 | Authored in-repo | UNKNOWN |

Note: provenance of the *ideas* behind preset vocabularies, i18n phrasing, and eval cases cannot be verified from the repository (UNKNOWN whether any were adapted from external sources without markers). No `Copyright`/`SPDX`/`Licensed under` markers exist anywhere in the repo.

## 12. AI usage record (status)

No tool, model, plan, dates, or policy links are recorded anywhere in the repository (no `.ai/`, no config, no commit metadata beyond author name). The record in section 6 remains **UNKNOWN** and must be completed by the owner from their own records. This audit did not fabricate any values. The code style and commit velocity are consistent with AI-assisted authoring, but that is an inference, not evidence.

## 13. Commercial SaaS licensing implications

- The project itself is `UNLICENSED` (no `LICENSE` file, no `license` field). Default copyright applies: all rights reserved. Anyone receiving the code has no right to use, modify, or distribute it. If this is intended to be a commercial SaaS, that is internally consistent, but it must be stated explicitly to customers and contributors.
- All 515 third-party dependencies are permissively licensed (MIT/ISC/Apache-2.0/BSD/0BSD/BlueOak/CC-BY/Unlicense/Python-2.0). No copyleft dependency ships. No dependency imposes source-disclosure or network-use (AGPL) obligations on the SaaS itself.
- The `Unlicense`-licensed dependency (`unlicense` package, 1 package) is public-domain-equivalent; no obligation.
- Gap: no `LICENSE` file, no contributor agreement, no CLA. If external contributors are accepted later, ownership of their contributions is **UNKNOWN**.

## 14. Third-party compliance requirements

### WhatsApp Cloud API (Meta)

- Used via `backend/src/integrations/messaging/meta.ts` against `https://graph.facebook.com` (pinned in production env validation).
- Requirements (from Meta's published platform terms, not summarized as legal advice): Business Verification, adherence to WhatsApp Business Policy (no spam, opt-in, 24-hour service window, approved templates for outbound outside the window), data processing terms, and restrictions on use of the API for certain categories. The code implements the 24-hour window check and template fallback (`outboundSender.ts`), and a consent flow (`consent.ts`).
- Gap: no documented mapping of which Meta policies the product relies on; no record of business verification status; template names are env-configured (`template_set`), not version-controlled.

### LLM provider

- Provider selectable via `LLM_PROVIDER` (`stub` or `openai`). Default `stub`.
- Consent text discloses that message text (including customer names) is sent to a third-party LLM provider and that phone numbers, addresses, and ledger data are never sent (`consent.ts`). Code redacts phone-like digit runs in `extraction.ts`.
- Gap: if `openai` is enabled in production, an OpenAI API agreement and data-use terms apply; whether training on API data is off must be verified with the provider's current terms (**UNKNOWN** from the repo). No DPA on file in the repo.

### Speech-to-text

- Provider selectable via `STT_PROVIDER` (`stub` or `whisper`). Default `stub`.
- Consent text does **not** mention voice audio or transcription. If STT is enabled, the consent flow must be extended before voice data is sent. Currently a compliance gap.

## 15. Missing policies and data governance

No Privacy Policy, Terms of Service, Cookie Policy, or Data Processing Agreement exists in the repository (none in `docs/`, `frontend/`, or `README.md`).

India Digital Personal Data Protection Act (DPDP) and general privacy obligations likely require (not legal advice; verify with counsel):

- Privacy Policy: categories of personal data (names, phone numbers, transaction data), purposes, third-party processors (Meta, LLM, STT), retention, rights (access, correction, erasure), grievance officer.
- Terms of Service: acceptable use, WhatsApp policy compliance, limitation of liability, IP ownership, termination.
- Data retention: `docs/14-retention-and-anonymisation.md` exists; verify it is implemented (retention jobs, anonymisation) -- **UNKNOWN** from this audit whether retention is automated.
- Consent versioning is implemented (`consent.ts`, `privacy-v3`), but the consent text is in English/Hindi code strings; whether it meets statutory notice requirements is **UNKNOWN**.

## 16. Tenant data isolation verification

Verified facts:

- All shop-owned tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` with a tenant policy (`migrations/0003_rls.sql` and later).
- `backend/src/db/tenant.ts`: `withTenant()` is the only way to set `app.shop_id` (transaction-local via `set_config(..., true)`); RLS fails closed when unset.
- `check:tenant` script passes (exit 0) -- validates no shop-owned table lacks FORCE RLS/policy/NOT NULL, and role grants are correct (`bma_app` is NOSUPERUSER NOBYPASSRLS).
- Non-RLS platform tables (`inbox_messages`, `security_events`, `login_index`, `provider_message_index`, `evening_schedule`) carry no financial data or are read only via SECURITY DEFINER functions returning identifiers (`list_due_shop_ids` returns only `shop_id`).
- `inbox.ts` uses SECURITY DEFINER functions `claim_next_inbox_message` / `claim_next_inbox_message_global` that return only id + shop_id.
- `queryWithoutTenant` usages (alerts, eveningScheduler, inbox, outboundSender, statusWebhook, testChannel routes) touch only non-RLS platform tables or SECURITY DEFINER functions; none read ledger/customer/entry data without tenant context.
- `evening_schedule` projection is excluded from the catalog's RLS requirement (it is not shop-owned tenant data).

Conclusion: tenant isolation is implemented and verified by automated checks. Residual risk: any future query that uses `queryWithoutTenant` against a shop-owned table would bypass RLS; the catalog test does not catch new tables automatically unless they have a `shop_id` column.

## 17. Prioritized compliance gap report

Priority 1 (blocker for commercial launch):
1. No Privacy Policy or Terms of Service anywhere in the product. (Gap)
2. No declared license on the repository; default all-rights-reserved. Decide and document commercial/proprietary terms. (Gap)
3. Consent text does not cover voice/STT data; STT provider path exists but is undisclosed. (Gap)
4. No DPA or recorded compliance posture for Meta WhatsApp Cloud API and LLM provider. (Gap/UNKNOWN)

Priority 2 (before scaling):
5. Retention/anonymisation: `docs/14-retention-and-anonymisation.md` exists but automation is unverified. (UNKNOWN)
6. Template management: WhatsApp template names are env-configured, not version-controlled or reviewed. (Gap)
7. No contributor agreement / CLA if external contributions are accepted. (Gap)
8. No record of which AI tools/models were used to author the code (section 6). (Gap/UNKNOWN)

Priority 3 (hardening):
9. Catalog test does not auto-detect new shop-owned tables without `shop_id` or non-standard naming. (Gap)
10. No monitoring/alerting vendor is wired; if added, it must be added to the data-flow table. (Gap)
11. Eval/holdout datasets are synthetic but provenance of any real seller examples is **UNKNOWN**. (UNKNOWN)

## 18. Verification

- Tests: 275 passed / 275, 40 files.
- `tsc --noEmit -p backend/tsconfig.json`: exit 0.
- `eslint .`: exit 0.
- `check:tenant`: exit 0.
- No production functionality was modified by this audit.
