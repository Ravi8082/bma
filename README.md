# Business Memory AI

**Your entire business. One WhatsApp conversation.**

AI-powered WhatsApp bookkeeping and business operating system for Indian micro-sellers.
TypeScript + PostgreSQL + Redis + React + WhatsApp Cloud API.

> Stage: **Phase 1 — persistence redesign to PostgreSQL, security design awaiting approval.**
> The ledger schema and isolation design are in [docs/13-rls-and-roles.md](docs/13-rls-and-roles.md);
> the threat model and test plan are in [docs/11-threat-model.md](docs/11-threat-model.md) and
> [docs/12-security-test-plan.md](docs/12-security-test-plan.md).
> No financial entry can be posted yet; that starts in Phase 2–5. Phases run one at a time, each awaiting approval.

## Run it

```bash
npm install
docker compose up -d          # PostgreSQL + Redis
npm run db:migrate            # forward-only migrations (added with the PostgreSQL implementation)
npm run dev                   # API on :4000 + dashboard shell on :5173
```

> The migration command is part of the PostgreSQL implementation, which is paused until the
> security design in docs 11–13 is approved.

`GET /health/ready` must report `database: true, queue: true`.
Simulator inbox: `http://localhost:4000/simulator`.

## Read in this order

| # | Document | What it answers |
|---|----------|-----------------|
| 00 | [docs/00-open-decisions.md](docs/00-open-decisions.md) | Decisions I need from you before code touches money or WhatsApp policy |
| 01 | [docs/01-architecture.md](docs/01-architecture.md) | System shape, request flows, background jobs, provider interfaces, trade-offs |
| 02 | [docs/02-data-model.md](docs/02-data-model.md) | Domain model: entities, fields, relationships, indexes (physical SQL schema in 13) |
| 03 | [docs/03-api-surface.md](docs/03-api-surface.md) | REST endpoints, auth, errors, idempotency, pagination |
| 04 | [docs/04-folder-structure.md](docs/04-folder-structure.md) | Repository layout, module anatomy, dependency rules |
| 05 | [docs/05-tier1-plan.md](docs/05-tier1-plan.md) | Phase-by-phase build order with acceptance tests |
| 06 | [docs/06-testing-strategy.md](docs/06-testing-strategy.md) | Test pyramid, fixtures, eval corpus, CI gates |
| 07 | [docs/07-security-privacy.md](docs/07-security-privacy.md) | Tenant isolation, prompt-injection defence, DPDP posture |
| 08 | [docs/08-environments.md](docs/08-environments.md) | Env matrix, env vars, local run without Meta credentials |
| 09 | [docs/09-money-in-postgres.md](docs/09-money-in-postgres.md) | How paise are stored, exactness bounds, aggregation rules |
| 10 | [docs/10-admin-access.md](docs/10-admin-access.md) | Audited, per-shop, time-boxed admin access |
| 11 | [docs/11-threat-model.md](docs/11-threat-model.md) | Assets, attackers, abuse cases, mitigations, residual risk |
| 12 | [docs/12-security-test-plan.md](docs/12-security-test-plan.md) | SQL injection, IDOR, RLS bypass, auth, rate-limit and AI test suites |
| 13 | [docs/13-rls-and-roles.md](docs/13-rls-and-roles.md) | Three DB roles, RLS policies, Phase 1 schema, append-only ledger, query helpers |
| 14 | [docs/14-retention-and-anonymisation.md](docs/14-retention-and-anonymisation.md) | Retention periods and the erasure/anonymisation procedure, for legal review |
| 15 | [docs/phase-1-delivery.md](docs/phase-1-delivery.md) | What Phase 1 shipped, how it was verified, known gaps |
| 16 | [docs/phase-2-acceptance-checklist.md](docs/phase-2-acceptance-checklist.md) | Phase 2 checklist — awaiting approval |

## The five rules that shape every file

1. Money is `integer paise`, stored as PostgreSQL `BIGINT` with a `CHECK`. Never floats, never `Decimal128`, never `NUMERIC` money.
2. An LLM never writes a financial record. It only proposes a draft; a human confirms.
3. Every shop-owned table has `shop_id NOT NULL`. PostgreSQL RLS plus scoped query helpers refuse any access without one shop in context.
4. Posted ledger entries are immutable: no `UPDATE`, no `DELETE`, no `TRUNCATE`. Corrections are reversals linked to the original.
5. No customer message leaves the system without seller approval or a pre-approved rule.

## Scope discipline

Tier 1 proves value with 10–20 paying sellers: simulator, onboarding, webhook, text + voice,
extraction, approvals, ledger + undo, customers/aliases, basic promises, daily summary,
seller-approved reminders, confirm-based payment matching, export, subscription basics.

Everything in Tier 2–4 is referenced in the model design (so we don't repaint later) but is
**not built** and stays dark behind feature flags.
