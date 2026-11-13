# 04 — Folder structure

npm workspaces monorepo. TypeScript everywhere, `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`. Path alias `@/*` → `backend/src/*`, `@shared/*` → `shared/src/*`.

```
business-memory-ai/
├─ package.json                 # workspaces: shared, backend, frontend
├─ tsconfig.base.json
├─ docker-compose.yml           # postgres + redis (local; DB/Redis not publicly exposed)
├─ .github/workflows/ci.yml
├─ docs/                        # this design package
│
├─ backend/migrations/          # forward-only SQL, applied by postgres-migrations
│  ├─ 0001_schema_and_roles.sql
│  ├─ 0002_tables.sql
│  ├─ 0003_rls_policies.sql
│  ├─ 0004_append_only_triggers.sql
│  └─ 0005_indexes_and_grants.sql
│
├─ shared/                      # contracts imported by BOTH sides
│  ├─ src/
│  │  ├─ money/                 # paise math, allocation, GST split, formatting
│  │  │  ├─ money.ts            # Paise branded type, add/sub/mul, safe-int guards
│  │  │  ├─ allocate.ts         # split amount across lines without losing paise
│  │  │  ├─ gst.ts              # per-line / per-invoice rounding, CGST|SGST|IGST split
│  │  │  ├─ format.ts           # ₹1,50,000 (Indian grouping, en-IN)
│  │  │  └─ *.test.ts
│  │  ├─ schemas/               # Zod: api payloads + AI extraction output
│  │  ├─ types/                 # API DTOs, enums, domain unions
│  │  ├─ constants/             # categories, payment methods, flags, error codes
│  │  ├─ events/                # outbox topic + payload contracts
│  │  └─ i18n/                  # message keys + hi/mr/en/hinglish strings
│  └─ package.json
│
├─ backend/
│  ├─ src/
│  │  ├─ server.ts              # http listen, graceful shutdown
│  │  ├─ app.ts                 # express wiring only
│  │  ├─ config/
│  │  │  ├─ env.ts              # Zod-validated process.env, fails fast
│  │  │  ├─ db.ts               # pg Pool, withTransaction, pingDb
│  │  │  ├─ redis.ts            # ioredis + bullmq connection
│  │  │  ├─ logger.ts           # pino, redaction paths
│  │  │  └─ flags.ts            # flag registry + resolution
│  │  ├─ middleware/
│  │  │  ├─ auth.ts             # JWT verify → TenantContext
│  │  │  ├─ rbac.ts             # requireRole / requirePermission
│  │  │  ├─ feature.ts          # requireFeature(flag)
│  │  │  ├─ validate.ts         # Zod body/query/params
│  │  │  ├─ idempotency.ts
│  │  │  ├─ rateLimit.ts
│  │  │  ├─ requestId.ts
│  │  │  └─ error.ts            # AppError → envelope, no stack leak
│  │  ├─ db/
│  │  │  ├─ tenant.ts           # withTenant(), scoped helpers, fail-closed context
│  │  │  ├─ sql.ts              # reviewed sql`` tag: bound values, allowlisted identifiers
│  │  │  ├─ migrate.ts          # postgres-migrations runner (migrator role only)
│  │  │  ├─ repositories/       # the only code allowed to issue SQL
│  │  │  └─ helpers/paginate.ts
│  │  ├─ modules/               # ← one folder per bounded context
│  │  │  ├─ auth/
│  │  │  │  ├─ auth.routes.ts
│  │  │  │  ├─ auth.controller.ts
│  │  │  │  ├─ auth.service.ts
│  │  │  │  ├─ auth.schemas.ts
│  │  │  │  ├─ otp.service.ts
│  │  │  │  └─ auth.test.ts
│  │  │  ├─ shops/
│  │  │  ├─ onboarding/
│  │  │  ├─ customers/
│  │  │  ├─ ledger/            # postings, reversals, balance derivation
│  │  │  ├─ transactions/      # pending drafts: create/confirm/reject/clarify
│  │  │  ├─ payments/          # payment records + confirm-based matching
│  │  │  ├─ promises/
│  │  │  ├─ reminders/
│  │  │  ├─ reports/
│  │  │  ├─ memory/            # retrieval context + "ask" questions
│  │  │  ├─ exports/
│  │  │  ├─ subscription/
│  │  │  ├─ onboarding-presets/
│  │  │  └─ admin/
│  │  │     └─ each: routes · controller · service · repository · schemas · models · __tests__
│  │  ├─ repositories/           # SQL per module, always via withTenant()
│  │  ├─ whatsapp/
│  │  │  ├─ webhook.routes.ts    # raw body + signature
│  │  │  ├─ ingest.service.ts
│  │  │  ├─ router.ts            # conversation state machine
│  │  │  ├─ commands/            # help, undo, balance, summary, stop …
│  │  │  ├─ renderer.ts          # message text/buttons per language
│  │  │  └─ __tests__/
│  │  ├─ ai/
│  │  │  ├─ prompts/             # versioned prompt files + manifest
│  │  │  ├─ extraction.service.ts
│  │  │  ├─ grounding.ts         # numbers must exist in source
│  │  │  ├─ normalise/           # number words, units, relative dates, script
│  │  │  ├─ intent-classifier.ts
│  │  │  └─ __tests__/ + eval/
│  │  ├─ integrations/
│  │  │  ├─ messaging/{types,meta,simulator}.ts
│  │  │  ├─ llm/{types,openai,stub}.ts
│  │  │  ├─ stt/{types,whisper,stub}.ts
│  │  │  ├─ ocr/{types}.ts       # interface only in Tier 1
│  │  │  ├─ storage/{types,local,s3}.ts
│  │  │  └─ payment/{types}.ts   # interface only in Tier 1
│  │  ├─ jobs/
│  │  │  ├─ queues.ts            # names, defaults, backoff
│  │  │  ├─ worker.ts            # boots all workers
│  │  │  ├─ processors/inbound.ts
│  │  │  ├─ processors/extraction.ts
│  │  │  ├─ processors/outbox.ts
│  │  │  ├─ processors/scheduler.ts
│  │  │  └─ deadletter.ts
│  │  ├─ simulator/              # REST + CLI entry (dev only)
│  │  ├─ scripts/                # seed, create-admin, reindex, backup-check
│  │  └─ test/
│  │     ├─ setup.ts             # embedded-postgres + migrations, global setup
│  │     ├─ fixtures/
│  │     └─ helpers/tenant.ts    # two shops, all roles, cleanup
│  ├─ package.json
│  └─ vitest.config.ts
│
├─ frontend/
│  ├─ src/
│  │  ├─ main.tsx · App.tsx · router.tsx
│  │  ├─ lib/{api.ts,query.ts,auth.ts,money.ts,i18n.ts}
│  │  ├─ components/ui/           # shadcn
│  │  ├─ features/
│  │  │  ├─ auth/ · onboarding/ · overview/ · customers/ · transactions/
│  │  │  ├─ approvals/ · promises/ · reports/ · settings/ · admin/
│  │  │  └─ each: pages · hooks · components · schemas
│  │  └─ pwa/{manifest,sw.ts}
│  ├─ e2e/                        # playwright
│  └─ vite.config.ts
│
└─ infrastructure/
   ├─ docker/{backend.Dockerfile,frontend.Dockerfile}
   └─ deploy/{staging,production}.md
```

## Module anatomy (enforced, not suggested)

```
modules/<name>/
  <name>.routes.ts      // paths + middleware only, ≤ 40 lines
  <name>.controller.ts  // HTTP ⇄ service, no business logic
  <name>.service.ts     // business rules, transactions, audit
  <name>.repository.ts  // all SQL, tenant-scoped by signature, bound parameters only
  <name>.schemas.ts     // Zod request/response
  __tests__/            // service + route tests, in-memory replset
```

Dependency direction: `routes → controller → service → repository → model`. A service may call
another module's **service** (never its repository), which keeps invariants in one place
(`ledger` is the only writer of `ledgerEntries`; `transactions` calls `ledger.post()`).

## Lint rules that encode the brief

- `no-restricted-imports`: frontend may not import `backend/*`.
- `no-restricted-syntax`: no SQL outside `*.repository.ts`; no `pg` import outside `src/db/**`;
  no `parseFloat`/`Number()` on money fields; no `Date.now()` inside financial services (use the
  injected clock).
- `no-console`: use `logger`.
- `import/no-cycle`.
- Custom rule `bma/no-dynamic-sql`: rejects template literals with expressions or `+`
  concatenation passed to a query; CI also greps for it.
- Custom script `npm run check:tenant` asserts every route is registered with a tenant scope.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | api + worker + frontend (concurrently) |
| `npm run dev:api` / `dev:worker` / `dev:web` | individually |
| `npm test` | vitest unit + integration (embedded PostgreSQL + real Redis in CI) |
| `npm run test:security` | injection, IDOR, RLS bypass, auth, rate-limit suites |
| `npm run test:e2e` | playwright against seeded local stack |
| `npm run eval` | 200+ extraction eval corpus, accuracy report, CI threshold |
| `npm run sim -- "<text>"` | simulator CLI |
| `npm run db:migrate` | forward-only SQL migrations as the migrator role |
| `npm run db:seed` | presets, plans, templates, demo shop (idempotent) |
| `npm run typecheck` / `lint` | CI gates |
