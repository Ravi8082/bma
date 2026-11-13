# 08 — Environments, configuration, and running locally

## Environments

| | local | staging | production |
|---|---|---|---|
| Messaging | simulator | Meta test number | Meta production number |
| PostgreSQL | docker `postgres:16` | managed PostgreSQL 16 `ap-south-1` | managed PostgreSQL 16 `ap-south-1`, PITR + encrypted backups |
| Redis | docker | managed, same region | managed, same region |
| LLM/STT | stub provider by default; real key optional | real | real, budget-capped |
| Storage | local disk (`./.data/media`) | S3 `ap-south-1` | S3 `ap-south-1` |
| Payments | disabled | disabled | disabled (Tier 1) |

`NODE_ENV=production` hard-disables `/simulator/*` and requires `MESSAGING_PROVIDER=meta`.

## Environment variables

```ini
NODE_ENV=development
PORT=4000
APP_BASE_URL=http://localhost:4000
DASHBOARD_ORIGIN=http://localhost:5173

# PostgreSQL / Redis — separate roles, separate secrets
DATABASE_URL=postgres://bma_app:<secret>@localhost:5432/business_memory?sslmode=disable
MIGRATION_DATABASE_URL=postgres://bma_migrator:<secret>@localhost:5432/business_memory?sslmode=disable
DB_POOL_MAX=20
DB_SSL_MODE=disable                   # production: verify-full
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET_CURRENT=<32+ bytes>
JWT_SECRET_PREVIOUS=
ACCESS_TOKEN_TTL=12m                  # 10–15 min
REFRESH_TOKEN_TTL=30d
COOKIE_DOMAIN=localhost
COOKIE_SECURE=false
CSRF_SECRET=<32+ bytes>

# Application secrets — production values come from the secret manager, never git
OTP_PEPPER=<32+ bytes>                # HMAC-SHA256 pepper; rotation invalidates all OTPs
PHONE_BLIND_INDEX_KEY=<32 bytes>      # HMAC key for the phone/address blind index
FIELD_ENCRYPTION_KEY_REF=<kms-key-id> # envelope key; per-environment, rotatable

# WhatsApp
MESSAGING_PROVIDER=simulator          # simulator | meta
WHATSAPP_VERIFY_TOKEN=<random>
WHATSAPP_APP_SECRET=<from Meta app>
WHATSAPP_ACCESS_TOKEN=<system user token>
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=

# AI
LLM_PROVIDER=stub                     # stub | openai
LLM_API_KEY=
LLM_MODEL_CHEAP=
LLM_MODEL_STRONG=
STT_PROVIDER=stub                     # stub | whisper
STT_API_KEY=

# Storage
STORAGE_PROVIDER=local                # local | s3
S3_BUCKET=
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=

# Money / policy defaults (overridable per shop)
DEFAULT_TIMEZONE=Asia/Kolkata
DRAFT_TTL_MINUTES=30
MAX_ENTRY_PAISE=100000000000
FINANCIAL_YEAR_START_MONTH=4

# Ops
LOG_LEVEL=info
FEATURE_KILL_SWITCH=
ADMIN_SEED_EMAIL=
ADMIN_SEED_PASSWORD=
SENTRY_DSN=
```

`config/env.ts` validates this with Zod and **exits with a readable list of missing keys** rather
than crashing mid-request. Secrets never appear in `shared/` or the frontend bundle; the frontend
only gets `VITE_API_URL`.

## Local run (this machine)

Available: Node 24, git, npm (call `npm.cmd`; the `.ps1` shim is blocked by execution policy),
no Docker, no local PostgreSQL server.

Practical path for Phase 1 here:
1. `docker-compose.yml` is provided and is the canonical setup; if Docker is installed later,
   `docker compose up -d` gives PostgreSQL 16 + Redis, then `npm run db:migrate` once.
2. Without Docker, tests run against `embedded-postgres`, which downloads PostgreSQL binaries once
   and applies the real migrations. If that download is blocked, the fallback is a managed
   PostgreSQL free tier via `DATABASE_URL` — I will ask before creating any cloud resource.
3. Redis: for local dev without Redis, BullMQ runs in an in-process "inline queue" adapter (same
   processor functions) behind `QUEUE_DRIVER=inline`. **Security tests that prove rate limiting
   require a real Redis** and are skipped locally with a loud warning, never silently passed.
   Production always uses Redis and refuses `inline`.

Trade-off, stated plainly: `QUEUE_DRIVER=inline` loses retry durability and cross-instance
locking. It exists for local demos only and is refused when `NODE_ENV=production`.

## Deployment shape (Tier 1)

- One API container (min 2 replicas in prod), one worker container per queue group, static
  frontend on a CDN.
- Managed PostgreSQL 16 in a private subnet (no public endpoint), TLS `verify-full`, PITR on.
- Migrations run as `bma_migrator` in a separate deploy step; the API runs as `bma_app` and never
  receives the migrator secret. `postgres-migrations` records applied ids/hashes in `migrations`.
- Rollback = redeploy the previous image; schema changes are forward-only and additive
  (expand → backfill → contract). A destructive change needs a verified backup first.
- Health checks: `/health` (liveness) and `/health/ready` (PostgreSQL ping, Redis ping, queue depth).
- Graceful shutdown: stop accepting, drain in-flight jobs up to 25 s, close PostgreSQL/Redis.

## Backup & restore

Daily managed snapshot + continuous WAL/PITR, plus a weekly `pg_dump` to an encrypted bucket in a
separate account, 35-day retention. Restore drill is a Phase 9 acceptance item: restore into a clean
database, compare row counts and a checksum of `ledger_entries.amount_paise` per shop, and record
the drill result in `docs/ops/restore-log.md`.

## Cost-control defaults

`rateTables` seeded with current Meta template categories and LLM per-1K-token prices, editable
without deploy. Alerts when a shop's 30-day cost exceeds 25 % of its plan price (configurable).
Free-form replies preferred inside the 24-hour window; templates only when required.
