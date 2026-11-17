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
'@
path<rfl:parameter name=" = "C:\\Users\\Asus\\Documents\\Default Project\\business-memory-ai\\docs\\ip-record.md"
write(path, content)