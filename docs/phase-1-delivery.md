# Phase 1 delivery — foundation

> **Superseded on 2026-11-13.** Phase 1 is re-opened for the PostgreSQL rewrite. This document
> records the Mongo-era delivery for history; it is **not** the current state. The current target
> schema, roles and RLS design are in [13-rls-and-roles.md](13-rls-and-roles.md); the security
> model is in [11-threat-model.md](11-threat-model.md) and
> [12-security-test-plan.md](12-security-test-plan.md). Phase 2 has not started.

Status: **Mongo-era foundation delivered; being ported to PostgreSQL. Phases 2–9 are not started.**

## What was built (Mongo-era, being replaced)

| Area | Files | Notes |
|---|---|---|
| Monorepo | `package.json`, `tsconfig.base.json`, workspaces `shared` / `backend` / `frontend` | npm workspaces, TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| Money engine | `shared/src/money/{money,allocate,gst,format}.ts` | integer paise, branded type, half-up rounding, largest-remainder allocation, per-line and per-invoice GST, Indian grouping |
| Config | `backend/src/config/env.ts` | Zod-validated, fails fast, production refinements (no simulator, no inline queue, secure cookies, 32+ byte JWT secret, Meta credentials required) |
| Logging | `backend/src/config/logger.ts` | pino, redaction of auth headers / OTP / tokens / phone numbers / transcripts |
| Database | `backend/src/config/db.ts` | **replaced:** was Mongo replica-set detection, `withTransaction()`, `pingMongo()`; target is `pg` Pool + `withTransaction` + `pingDb` |
| Tenant isolation | `backend/src/db/plugins/tenantGuard.ts`, `db/scopedSchema.ts` | **replaced:** was a Mongoose guard; target is PostgreSQL RLS + `withTenant()` scoped helpers |
| HTTP | `app.ts`, `server.ts`, middleware, `health/` | request-id, helmet, CORS allowlist, error envelope, liveness + readiness, graceful shutdown |
| Queue | `backend/src/jobs/queue.ts` | `QueueDriver` contract + in-process driver with retries, dead letters, idempotency keys |
| Messaging | `backend/src/integrations/messaging/*` | provider interface, simulator provider, factory that refuses to fake Meta |
| Simulator | `backend/src/simulator/*` | in-memory outbox, HTML inbox, REST helpers, media registration, reset |
| Frontend | `frontend/src/*` | Vite + React shell: API status, money formatting demo, simulator outbox |
| Infra | `docker-compose.yml`, `.github/workflows/ci.yml` | **being replaced:** Mongo 7 → PostgreSQL 16; Redis 7; CI on Node 22 |
| Tests | `shared/**/*.test.ts`, `backend/src/test/*` | 69 Mongo-era tests; the DB/Tenant/Money aggregation tests are being rewritten for PostgreSQL |

## Verification — Mongo era (historical)

These results were produced **before** the PostgreSQL decision. They are kept for provenance and
must not be read as the current state of the repository.

```
npm install                 → 454 packages
npm run typecheck           → shared + backend + frontend clean
npm run lint                → clean
npm run test -w @bma/shared → 42 passed
npm run test -w @bma/backend→ 27 passed (replica-set MongoDB via mongodb-memory-server)
npm run build               → shared dist, backend bundle (23 KB), frontend bundle (147 KB)
npm run dev:memory          → API up, /health/ready → ready:true, database:true, queue:true
POST /simulator/send        → message recorded, visible at GET /simulator
```

## Current status (PostgreSQL rewrite, in progress)

| Item | State |
|---|---|
| PostgreSQL dependencies (`pg`, `postgres-migrations`, `embedded-postgres`) | installed |
| Mongoose / `mongodb-memory-server` dependencies | removed from `backend/package.json` |
| Source using Mongoose (`config/db.ts`, `db/plugins/tenantGuard.ts`, `db/scopedSchema.ts`, `db/tenantModel.ts`) | **not yet replaced** — the tree is mid-migration |
| Typecheck / lint / tests | **will fail until the PostgreSQL port lands**; do not treat as a regression |
| Migrations `0001…0005` | written only after docs 11–13 are approved |
| Docker compose / CI | still reference MongoDB; to be switched with the port |

The honest summary: Phase 1 is **not** complete under the new design. Money engine, env config,
logging, queue contract, simulator and frontend shell carry over unchanged; the persistence and
isolation layers are being rebuilt.

## Acceptance checklist (PostgreSQL target, from docs/05)

- [ ] `docker compose up -d` gives PostgreSQL 16 + Redis; DB/Redis are not publicly exposed
- [ ] `npm run db:migrate` applies `0001…0005` as `bma_migrator`; re-running is a no-op
- [ ] `/health` and `/health/ready` (`pingDb` as `bma_app`, queue depth)
- [ ] integer paise arithmetic, allocation, GST split, INR formatting, overflow guards
- [ ] `fromDatabasePaise` / `toDatabasePaise` preserve exact `BIGINT` values
- [ ] every shop-owned table: `shop_id NOT NULL`, RLS enabled **and forced**, policy present
- [ ] no `app.shop_id` context → zero rows, insert rejected
- [ ] `UPDATE`/`DELETE`/`TRUNCATE` on `ledger_entries`/`audit_logs` → `42501`
- [ ] duplicate `(shop_id, idempotency_key)` and `(shop_id, wa_message_id)` rejected
- [ ] `bma_app` is `NOSUPERUSER`, `NOBYPASSRLS`, no DDL, no `TRUNCATE`, cannot `SET ROLE`
- [ ] SQL injection payload is bound, never concatenated; `bma/no-dynamic-sql` fails a bad fixture
- [ ] CI: typecheck → lint → unit → integration (real PostgreSQL) → security → build, Node 22
- [ ] **no business logic, no financial writes** — Phase 2 has not started

## How to run (once the port lands)

```bash
npm install
docker compose up -d          # PostgreSQL 16 + Redis
npm run db:migrate            # as bma_migrator
npm run dev                   # api :4000 + web :5173

# Simulator (unchanged)
POST http://localhost:4000/simulator/send
{ "to": "+919876543210", "text": "Rahul ko 500 ka maal diya" }
open http://localhost:4000/simulator
```

On this machine there is no Docker, so integration tests run against `embedded-postgres`, which
downloads PostgreSQL binaries once and applies the real migrations.

## Deliberate gaps in this phase

- `MESSAGING_PROVIDER=meta` throws `ProviderNotImplementedError` (Phase 3). Production env validation
  therefore fails until then — intentional, not a bug.
- Queue driver is in-process only; `QUEUE_DRIVER=bullmq` is rejected at config level until Phase 3
  wires BullMQ.
- Frontend has no auth, no router, no Tailwind yet; it is a status shell, not the dashboard (Phase 8).
- Security tests that need real Redis are skipped locally with a loud warning and are blocking in CI.
- Node here is 24; CI pins 22. `engines` allows 22–24.

## Next phase (needs your go-ahead)

Phase 2 — identity and onboarding: `shops`, `users`, `shop_settings`, `plans`, `subscriptions`,
`consent_records`, OTP + refresh rotation, RBAC, onboarding conversation, presets, feature flags.
Acceptance tests are listed in `docs/05-tier1-plan.md` and
`docs/phase-2-acceptance-checklist.md`.
