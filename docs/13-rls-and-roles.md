# 13 — RLS, roles and the PostgreSQL schema

**Status: approved 2026-11-13 with ten changes (see §14a). Migrations may be written.**
Read with `docs/11-threat-model.md` (`R-01`…`R-12`) and `docs/12-security-test-plan.md`
(`DB-01`…`DB-48`, `WH-01`…`WH-08`).

This document replaces the Mongoose-era `tenantGuard`, `scopedSchema` and `tenantModel` design.
The shared money engine, env validation, logging, queue contract, WhatsApp simulator and frontend
shell are unchanged.

## 1. Principles

1. **Deny by default.** No grant, no policy, no access.
2. **One shop per transaction.** `SET LOCAL app.shop_id` is the only tenant input; it is never read
   from a request body, query string, header or message.
3. **Fail closed.** Missing context returns zero rows and rejects inserts.
4. **Least privilege.** The runtime role cannot DDL, truncate, become the migrator, or bypass RLS.
5. **Defence in depth.** RLS + scoped helpers + composite foreign keys + append-only triggers +
   `CHECK` constraints + audit. Each layer assumes the one above it has a bug.
6. **No string-built SQL.** Values are bound; identifiers are allowlisted; raw `query()` exists only
   in `src/db/**`.
7. **Money is integer paise.** `BIGINT`, `CHECK`, no floats, no `NUMERIC` money, no rupees at rest.
8. **Durability before dispatch.** An inbound webhook is committed to PostgreSQL before a queue
   job exists. Redis is never the only copy of a message.
9. **Keys never enter the database.** The OTP pepper, blind-index key and encryption keys live in
   the secret manager/KMS; only ciphertext, blind index and `key_version` are stored.

## 2. Database roles

### 2.1 Three runtime roles, one bootstrap step

| Role | Login | Superuser | Bypass RLS | Create DB | Create role | Owns schema | Purpose |
|---|---|---|---|---|---|---|---|
| `bma_migrator` | yes (deploy job only) | no | no | no | no | yes, `app` | DDL, migrations, index creation |
| `bma_app` | yes | no | no | no | no | no | API and workers |
| `bma_reporting` | yes | no | no | no | no | no | read-only reporting/analytics |

The database, roles and passwords are created **once** by a DBA/bootstrap superuser, not by an
application migration. The bootstrap superuser is an operational account, not a fourth application
role, and is never used by the API.

```sql
-- bootstrap.sql — run once by a DBA, not by the app, not in CI migrations.
CREATE ROLE bma_migrator LOGIN PASSWORD :'migrator_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE bma_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
CREATE ROLE bma_reporting LOGIN PASSWORD :'reporting_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

CREATE DATABASE business_memory OWNER bma_migrator;
REVOKE ALL ON DATABASE business_memory FROM PUBLIC;
GRANT CONNECT ON DATABASE business_memory TO bma_app, bma_reporting;
-- no TEMPORARY grant: the app does not need temp tables, and removing it narrows escape paths.
```

`NOINHERIT` means membership does not leak privileges implicitly; `bma_app` is not a member of
`bma_migrator` and cannot `SET ROLE` to it. Passwords come from the secret manager; none is in git.

### 2.2 Role settings

```sql
ALTER ROLE bma_migrator SET search_path = app, pg_catalog;
ALTER ROLE bma_migrator SET statement_timeout = '60s';
ALTER ROLE bma_migrator SET lock_timeout = '10s';
ALTER ROLE bma_migrator SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE bma_migrator CONNECTION LIMIT 5;

ALTER ROLE bma_app SET search_path = app, pg_catalog;
ALTER ROLE bma_app SET row_security = on;
ALTER ROLE bma_app SET default_transaction_read_only = off;
ALTER ROLE bma_app SET statement_timeout = '5s';
ALTER ROLE bma_app SET lock_timeout = '3s';
ALTER ROLE bma_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE bma_app SET application_name = 'bma-api';
ALTER ROLE bma_app CONNECTION LIMIT 60;

ALTER ROLE bma_reporting SET search_path = app, pg_catalog;
ALTER ROLE bma_reporting SET default_transaction_read_only = on;
ALTER ROLE bma_reporting SET statement_timeout = '30s';
ALTER ROLE bma_reporting SET lock_timeout = '3s';
ALTER ROLE bma_reporting SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE bma_reporting CONNECTION LIMIT 10;
```

`statement_timeout` is per role, not per query. A long export runs under `bma_reporting` with a
30 s cap and pagination, never by raising the API's 5 s cap. `idle_in_transaction_session_timeout`
is the backstop for a leaked client holding a transaction open.

### 2.3 Schema and privileges

```sql
CREATE SCHEMA app AUTHORIZATION bma_migrator;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO bma_app, bma_reporting;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO bma_app, bma_reporting;
```

`public` is not used for application objects. Pinning `search_path` to `app, pg_catalog` prevents
function/table hijacking through a writable schema.

| Object | `bma_app` | `bma_reporting` |
|---|---|---|
| schema `app` | USAGE | USAGE |
| `shops` | SELECT, INSERT, UPDATE | SELECT via view |
| `ledger_entries` | SELECT, INSERT | SELECT via view |
| `whatsapp_messages` | SELECT, INSERT, UPDATE, DELETE (retention) | SELECT via view |
| `idempotency_keys` | SELECT, INSERT, UPDATE, DELETE (cleanup) | none |
| `audit_logs` | SELECT, INSERT | SELECT via view |
| `security_events` | INSERT only | SELECT |
| `app.current_shop_id()` | EXECUTE | EXECUTE |
| `app.resolve_login(bytea)` | EXECUTE | none |
| `app.resolve_shop_by_phone(bytea)` | EXECUTE | none |
| sequences | none (UUIDs) | none |
| `TRUNCATE` | never | never |
| DDL | never | never |

Per-table grants are written in the same migration that creates the table. A catalog test fails CI
if a table with `shop_id` lacks RLS, a policy, `NOT NULL`, or the expected grants. We do not use
blanket `ALTER DEFAULT PRIVILEGES` for write grants, because it silently grants `UPDATE`/`DELETE`
on the next append-only table.

### 2.4 Column-level protection for reporting

`bma_reporting` reads `app.reporting_ledger` and `app.reporting_audit` views, not base tables.
Views are `security_invoker = true` so the caller's RLS and column privileges apply. PII columns
(`*_enc`, `*_bidx`, `body`, `note`) are excluded from reporting views. A report that genuinely
needs a phone number gets a masked projection, never the ciphertext or blind index.

## 3. Tenant context and RLS

### 3.1 The context function

```sql
CREATE FUNCTION app.current_shop_id() RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('app.shop_id', true), '')::uuid
$$;

REVOKE ALL ON FUNCTION app.current_shop_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_shop_id() TO bma_app, bma_reporting;
```

- `current_setting('app.shop_id', true)` returns `NULL` when unset (the `true` is `missing_ok`).
- `NULL::uuid` is `NULL`; `shop_id = NULL` is `NULL`, which RLS treats as false. No context →
  zero rows.
- An invalid UUID raises a cast error. The helper validates the UUID before setting it, so this is
  a programming error, not a user input path.
- The function is `STABLE`, so it is evaluated once per statement where possible.
- `SET search_path = pg_catalog` prevents a malicious `app`/`public` object from shadowing
  `current_setting`.

### 3.2 Per-transaction setting

`withTenant` opens a transaction and sets the context locally:

```ts
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  assertUuid(ctx.shopId, "shopId");
  return withTransaction(async (client) => {
    await client.query("SELECT set_config('app.shop_id', $1, true)", [ctx.shopId]);
    await client.query("SELECT set_config('app.actor_id', $1, true)", [ctx.actorId]);
    await client.query("SELECT set_config('app.request_id', $1, true)", [ctx.requestId ?? ""]);
    return fn(createTenantDb(client, ctx));
  });
}
```

Rules:

- `set_config(..., true)` is the parameterized form of `SET LOCAL`; it is transaction-scoped and
  resets on `COMMIT`/`ROLLBACK`.
- Never `SET SESSION app.shop_id`. A CI lint rule and a runtime statement guard reject it.
- The connection is released only after `COMMIT`/`ROLLBACK`. On an unexpected error the client is
  destroyed (`release(true)`) rather than reused, so an unknown session state cannot leak.
- A test runs `withTenant(A)`, commits, then checks `current_setting('app.shop_id', true) IS NULL`
  on the same connection.
- Background workers call `withTenant` from the job's `shop_id`; they never trust a job payload's
  actor or role without reloading the row.
- **CI check (`npm run check:tenant`):** `set_config`/`SET LOCAL` may appear only in
  `src/db/tenant.ts`. Any other file is a build failure. The job registry is enumerated and every
  processor must be wrapped in `withTenant`; an unwrapped processor fails the same check.
- **Transaction-mode pooling:** `SET LOCAL` (`set_config(..., true)`) is safe behind PgBouncer in
  `pool_mode=transaction` because it ends at `COMMIT`/`ROLLBACK`. A session-level `SET` would leak
  into the next client on the same server connection, which is exactly why it is banned and tested
  (`DB-43`). The pooler must not be configured in statement mode for this application.
- **No session state beyond the transaction:** the tenant helper does not use temporary tables,
  advisory locks held across transactions, or `SET SESSION`. `search_path` is a role default, not
  per-request state.

### 3.3 Policy templates

Tenant root (`shops`):

```sql
ALTER TABLE app.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shops FORCE ROW LEVEL SECURITY;

CREATE POLICY shops_tenant_isolation ON app.shops
  FOR ALL
  TO bma_app, bma_reporting
  USING (id = app.current_shop_id())
  WITH CHECK (id = app.current_shop_id());
```

Every shop-owned table:

```sql
ALTER TABLE app.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ledger_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY ledger_entries_tenant_isolation ON app.ledger_entries
  FOR ALL
  TO bma_app, bma_reporting
  USING (shop_id = app.current_shop_id())
  WITH CHECK (shop_id = app.current_shop_id());
```

- `FORCE` makes the policy apply to the table owner too. Without it, the owner (the migrator) would
  bypass RLS, and a mistake in a future migration could expose data.
- `WITH CHECK` prevents inserting another shop's `shop_id` and prevents moving a row between shops.
- A separate `BEFORE UPDATE` trigger rejects any `shop_id` change, as a second line of defence for
  privileged roles.
- `FOR ALL` is one policy, not separate `SELECT`/`INSERT`/`UPDATE`/`DELETE` policies. Grants still
  control which operations are possible; the policy only controls which rows.
- No policy is created for `PUBLIC`. A new role must be added deliberately.

### 3.4 Creating the first shop (the bootstrap exception)

`shops` has no `shop_id`; its policy is `id = app.current_shop_id()`. Onboarding generates the shop
UUID in the application, sets `app.shop_id` to that UUID, then inserts the shop. The `WITH CHECK`
passes because `id` equals the context. The same transaction inserts the owner, settings and
consent rows. If any insert fails, the whole transaction rolls back; no half-onboarded shop exists.

This does **not** allow reading another shop: the generated UUID is new, and the policy compares
the row's `id`, not an arbitrary filter.

### 3.5 Lookups that cannot be shop-scoped

Login and webhook routing must find a shop before a shop context exists. These are the only
cross-shop reads, and they are **not** exposed as table access:

| Function | Input | Output | Notes |
|---|---|---|---|
| `app.resolve_login(phone_bidx bytea)` | blind index | `user_id`, `shop_id`, `role`, `status` | used by OTP login; no name/ledger fields |
| `app.resolve_shop_by_phone(phone_bidx bytea)` | blind index | `shop_id`, `status` | used by inbound webhook routing |
| `app.resolve_admin(email_bidx bytea)` | blind index | `admin_id`, `password_hash`, `totp_secret_ref`, `status` | separate admin table |

Each is `SECURITY DEFINER`, owned by `bma_migrator`, with:

```sql
CREATE FUNCTION app.resolve_login(p_phone_bidx bytea)
RETURNS TABLE (user_id uuid, shop_id uuid, role text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT u.id, u.shop_id, u.role, u.status
  FROM app.login_index li
  JOIN app.users u ON u.id = li.user_id
  WHERE li.phone_bidx = p_phone_bidx
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION app.resolve_login(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_login(bytea) TO bma_app;
```

The function contract is enforced by the catalog test `DB-48`:

- **Owner:** `bma_migrator`, which is `NOSUPERUSER NOBYPASSRLS` and is never used by the API. The
  function owner is not a superuser, so the definer's rights do not include bypassing RLS or reading
  files.
- **Pinned `search_path`:** `proconfig` must contain `search_path=pg_catalog, app`. A function
  without it fails CI.
- **Execute:** `REVOKE ALL … FROM PUBLIC`; only `bma_app` has `EXECUTE` (and `bma_reporting` only
  where a reporting function is explicitly designed). `bma_app` has no direct `SELECT` on
  `login_index` or `admin_users`.
- **No dynamic SQL:** the body is a fixed `SELECT` with a fixed projection and `LIMIT 1`. No
  `EXECUTE`, no `format()`, no caller-supplied identifier.
- **Caller rate limit:** these functions are the cross-shop lookup for login and webhook routing, so
  the application rate-limits before calling (per phone blind index and per IP; fail-closed for
  login, bounded fail-open for webhook with durable persistence). A call without a rate-limit
  decision is a code-review failure and a coverage test failure (`AUTH-07`, `RATE-04`).
- **Audit:** every call is counted; repeated misses for the same blind index alert.

`login_index` is a **platform identity index**, not a shop-owned table: it holds `phone_bidx`,
`user_id`, `shop_id` and nothing financial. The app has no direct `SELECT` on it; only the
`SECURITY DEFINER` function can read it. The function returns the minimum needed to set the tenant
context, and the app rate-limits and audits every call. The same pattern is used for admin login.

**Why not a permissive RLS policy?** A policy such as `USING (true)` for an auth role is one
mistake away from a cross-shop table read. A function with a fixed projection, a pinned
`search_path`, no dynamic SQL and no direct grant is a smaller surface. The exception is listed in
the catalog test as a platform table, not a shop-owned table.

### 3.6 What RLS does and does not protect

| Protects against | Does not protect against |
|---|---|
| a forgotten `WHERE shop_id` | arbitrary SQL as `bma_app` (it can set the GUC; see R-01) |
| a foreign id from a client | a compromised application process |
| a join/aggregate that spans shops | a superuser or `BYPASSRLS` role |
| an insert into the wrong shop | `TRUNCATE` (RLS does not filter it; privilege + trigger handle it) |
| a row moved between shops | a `SECURITY DEFINER` function with a bad `search_path` |

## 4. Schema conventions

| Rule | Implementation |
|---|---|
| Schema | everything in `app`; `public` is empty and not writable |
| Primary key | `uuid PRIMARY KEY DEFAULT gen_random_uuid()` (no sequences, no cross-tenant id leakage) |
| Tenant key | `shop_id uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT` |
| Timestamps | `created_at timestamptz NOT NULL DEFAULT now()`; `updated_at` via trigger |
| Actor | `created_by text NOT NULL` (user/admin/system id, never free text from a client) |
| Optimistic concurrency | `version integer NOT NULL DEFAULT 1`; updates use `WHERE id=$1 AND shop_id=$2 AND version=$3` |
| Soft delete | `deleted_at timestamptz` only where history is not financial; ledger/audit have none |
| Cross-row reference | composite FK `(shop_id, other_id)` so a row cannot point at another shop's row |
| Money | `BIGINT` paise, `CHECK (amount_paise >= 0 AND amount_paise <= 100000000000)` |
| Currency | `char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR')` |
| Direction | `text CHECK (direction IN ('DEBIT','CREDIT'))`; amounts are non-negative |
| Text | `CHECK (length(btrim(x)) BETWEEN 1 AND n)`; no unbounded `text` from a client |
| JSON | `jsonb CHECK (jsonb_typeof(x) = 'object')`; size checked at the API boundary |
| Indexes | every FK; `(shop_id, <dominant query>)`; unique constraints as listed below |
| Naming | snake_case; constraints named `<table>_<rule>`; indexes `ix_<table>_<cols>` |

No `serial`/`bigserial`: a global sequence reveals volume and can leak ids across shops. UUIDs are
generated per row; the application may generate the id before insert to make retries idempotent.

## 5. Phase 1 target schema

Phase 1 does not expose ledger or messaging routes. It creates the tables that prove the
invariants Phase 2–5 depend on, and no business endpoints that can move money: `shops`,
`customers`, `ledger_entries`, `whatsapp_messages`, `idempotency_keys`, `audit_logs`,
`security_events`. `customers` is minimal (identity, encrypted contact fields, name) so
`ledger_entries.customer_id` can carry a same-shop composite FK; customer features are Phase 6.

### 5.1 `shops`

```sql
CREATE TABLE app.shops (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  preset_key          text NOT NULL CHECK (preset_key ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  language            text NOT NULL DEFAULT 'hi' CHECK (language IN ('hi','mr','en','hinglish')),
  timezone            text NOT NULL DEFAULT 'Asia/Kolkata',
  status              text NOT NULL DEFAULT 'ONBOARDING'
                        CHECK (status IN ('ONBOARDING','ACTIVE','SUSPENDED','CLOSED')),
  onboarded_at        timestamptz,
  trial_ends_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  version             integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE INDEX ix_shops_status_trial ON app.shops (status, trial_ends_at);
```

Phone numbers are **not** on `shops`. Identity lives in `users` (Phase 2) and is encrypted with a
blind index; a shop can have more than one staff number. `slug` is for share links and is not a
secret.

### 5.2 `ledger_entries` (append-only)

```sql
CREATE TABLE app.ledger_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  customer_id         uuid,
  posting_id          uuid NOT NULL,
  entry_seq           smallint NOT NULL CHECK (entry_seq > 0),
  entry_type          text NOT NULL CHECK (entry_type IN (
                        'SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','EXPENSE',
                        'REFUND','SALES_RETURN','OPENING_BALANCE','ADJUSTMENT','REVERSAL')),
  direction           text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_paise        bigint NOT NULL CHECK (amount_paise >= 0 AND amount_paise <= 100000000000),
  currency            char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  occurred_at         timestamptz NOT NULL,
  description         text CHECK (description IS NULL OR length(description) <= 500),
  source              text NOT NULL CHECK (source IN ('WHATSAPP','DASHBOARD','IMPORT','SYSTEM')),
  source_id           text,
  idempotency_key     text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_by          text NOT NULL CHECK (length(btrim(created_by)) > 0),
  reverses_entry_id   uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_entries_shop_id_id_unique UNIQUE (shop_id, id),
  CONSTRAINT ledger_entries_posting_seq_unique UNIQUE (shop_id, posting_id, entry_seq),
  CONSTRAINT ledger_entries_idempotency_unique UNIQUE (shop_id, idempotency_key),
  CONSTRAINT ledger_entries_reversal_chk CHECK (
    (entry_type = 'REVERSAL' AND reverses_entry_id IS NOT NULL)
    OR (entry_type <> 'REVERSAL' AND reverses_entry_id IS NULL)
  ),
  CONSTRAINT ledger_entries_reverses_same_shop_fk
    FOREIGN KEY (shop_id, reverses_entry_id)
    REFERENCES app.ledger_entries (shop_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ledger_entries_customer_same_shop_fk
    FOREIGN KEY (shop_id, customer_id)
    REFERENCES app.customers (shop_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ledger_entries_one_reversal
  ON app.ledger_entries (shop_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX ix_ledger_entries_shop_customer
  ON app.ledger_entries (shop_id, customer_id, occurred_at DESC);

CREATE INDEX ix_ledger_entries_shop_occurred
  ON app.ledger_entries (shop_id, occurred_at DESC);
CREATE INDEX ix_ledger_entries_shop_posting
  ON app.ledger_entries (shop_id, posting_id);
```

Why non-negative + `direction`: a signed amount invites sign-convention bugs across services and
SQL, and `SUM` of signed values makes "amount" and "balance" ambiguous. `direction` is explicit;
the balance is `SUM(CASE direction WHEN 'DEBIT' THEN amount_paise ELSE -amount_paise END)`. The
`CHECK` rejects negative values; a refund is a positive amount with the opposite direction.

Why `posting_id` + `entry_seq`: one seller action can create a multi-line posting (a bill with tax
lines). The pair is unique per shop, so a retry cannot insert a second copy of the same posting.
`idempotency_key` is unique per shop for the whole request; `posting_id` groups its lines.

Why the composite FK on `reverses_entry_id`: a plain FK would allow a shop A row to reference a
shop B row if the id were known. The composite `(shop_id, id)` FK makes that impossible at the
database level, not only in the service.

### 5.3 `whatsapp_messages`

```sql
CREATE TABLE app.whatsapp_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  wa_message_id     text NOT NULL CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  direction         text NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  message_type      text NOT NULL CHECK (message_type IN (
                      'TEXT','AUDIO','IMAGE','DOCUMENT','INTERACTIVE','TEMPLATE','SYSTEM')),
  from_phone_enc    bytea,
  from_phone_bidx   bytea,
  to_phone_enc      bytea,
  to_phone_bidx     bytea,
  body              jsonb NOT NULL DEFAULT '{}'::jsonb
                      CHECK (jsonb_typeof(body) = 'object'),
  status            text NOT NULL DEFAULT 'RECEIVED'
                      CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED',
                                        'SENT','DELIVERED','READ','FAILED','IGNORED')),
  received_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT whatsapp_messages_wa_unique UNIQUE (shop_id, wa_message_id)
);

CREATE INDEX ix_whatsapp_messages_shop_received
  ON app.whatsapp_messages (shop_id, received_at DESC);
CREATE INDEX ix_whatsapp_messages_bidx
  ON app.whatsapp_messages (shop_id, from_phone_bidx);
```

`wa_message_id` is unique **per shop**, not globally. A global unique constraint would let one
tenant's id block another tenant's insert and could reveal that an id exists. Meta ids are unique
per WABA; our routing already identifies the shop, so per-shop is the correct tenant key.

The phone columns are ciphertext (`bytea`) plus a blind index. The app never stores plaintext
`from`/`to` numbers. The provider's raw payload may contain them; the inbound worker redacts before
persisting `body`.

### 5.4 `idempotency_keys`

```sql
CREATE TABLE app.idempotency_keys (
  shop_id         uuid NOT NULL REFERENCES app.shops(id) ON DELETE CASCADE,
  scope           text NOT NULL CHECK (length(btrim(scope)) BETWEEN 1 AND 80),
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash    bytea NOT NULL,
  status          text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,

  PRIMARY KEY (shop_id, scope, key),
  CONSTRAINT idempotency_keys_completed_chk CHECK (
    (status = 'COMPLETED' AND response_status IS NOT NULL)
    OR (status <> 'COMPLETED')
  )
);

CREATE INDEX ix_idempotency_keys_expiry ON app.idempotency_keys (expires_at);
```

There is no TTL in PostgreSQL. A scheduled job deletes expired rows in bounded batches under the
`bma_app` role (`DELETE ... WHERE expires_at < now() LIMIT 1000`), with `statement_timeout`.
Idempotency rows are not financial records; deleting them is allowed. Ledger rows are never
deleted.

### 5.5 `audit_logs` (append-only)

```sql
CREATE TABLE app.audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id         uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  actor_type      text NOT NULL CHECK (actor_type IN ('USER','ADMIN','SUPPORT','SYSTEM','CUSTOMER')),
  actor_id        text NOT NULL CHECK (length(btrim(actor_id)) > 0),
  action          text NOT NULL CHECK (length(btrim(action)) BETWEEN 3 AND 100),
  entity_type     text,
  entity_id       text,
  before          jsonb,
  after           jsonb,
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  request_id      text,
  ip_hash         bytea,
  user_agent_hash bytea,
  sensitive_view  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_audit_logs_shop_created ON app.audit_logs (shop_id, created_at DESC);
CREATE INDEX ix_audit_logs_entity ON app.audit_logs (shop_id, entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_logs_actor ON app.audit_logs (shop_id, actor_id, created_at DESC);
```

`audit_logs` is shop-scoped. Platform events that are not tied to a shop (failed login for an
unknown number, webhook signature failure, rate-limit abuse) go to `security_events`, which is not
shop-owned and has no `shop_id`.

### 5.6 `security_events` (platform-level, insert-only)

```sql
CREATE TABLE app.security_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  event_type      text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 3 AND 100),
  severity        text NOT NULL CHECK (severity IN ('INFO','WARN','HIGH','CRITICAL')),
  actor_ref       text,
  ip_hash         bytea,
  user_agent_hash bytea,
  request_id      text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(detail) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_security_events_occurred ON app.security_events (occurred_at DESC);
CREATE INDEX ix_security_events_type ON app.security_events (event_type, occurred_at DESC);
```

The app role has `INSERT` only; it cannot read the table. `bma_reporting` has `SELECT` for the
security dashboard. No `shop_id`; this is deliberately outside the tenant model and contains no
financial data.

### 5.7 `customers` (minimal, Phase 1)

`ledger_entries.customer_id` must reference a row in the same shop, so the table exists in Phase 1
even though customer features (aliases, merge, promises, balance rebuild) are Phase 6.

```sql
CREATE TABLE app.customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id           uuid NOT NULL REFERENCES app.shops(id) ON DELETE RESTRICT,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  name_normalized   text NOT NULL CHECK (length(btrim(name_normalized)) BETWEEN 1 AND 80),
  phone_enc         bytea,
  phone_bidx        bytea,
  address_enc       bytea,
  notes_enc         bytea,
  key_version       smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  language          text CHECK (language IS NULL OR language IN ('hi','mr','en','hinglish')),
  balance_paise     bigint NOT NULL DEFAULT 0
                      CHECK (balance_paise BETWEEN -100000000000 AND 100000000000),
  opted_out_at      timestamptz,
  merged_into_id    uuid,
  last_transaction_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1 CHECK (version > 0),

  CONSTRAINT customers_shop_id_id_unique UNIQUE (shop_id, id),
  CONSTRAINT customers_phone_pair_chk CHECK (
    (phone_enc IS NULL AND phone_bidx IS NULL)
    OR (phone_enc IS NOT NULL AND phone_bidx IS NOT NULL)
  ),
  CONSTRAINT customers_merged_same_shop_fk
    FOREIGN KEY (shop_id, merged_into_id) REFERENCES app.customers (shop_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX customers_phone_bidx_unique
  ON app.customers (shop_id, phone_bidx)
  WHERE phone_bidx IS NOT NULL;
CREATE INDEX ix_customers_shop_name ON app.customers (shop_id, name_normalized);
CREATE INDEX ix_customers_shop_last_tx ON app.customers (shop_id, last_transaction_at DESC);
```

| Decision | Detail |
|---|---|
| Names | **not encrypted**; `name` and `name_normalized` stay searchable (approved change 2). Phone, address and notes are envelope-encrypted; `phone_bidx` is the only lookup path for a phone. |
| `key_version` | one per row, identifying the KMS data key used for all three encrypted fields. Rotation re-wraps the data key; a row is rewritten lazily on read+write or by a bounded re-encryption job. |
| `balance_paise` | a **derived cache**, signed, rebuilt from the ledger; it is not a ledger amount and is never the source of truth. The ledger's non-negative rule still applies to `ledger_entries.amount_paise`. |
| RLS | `ENABLE` + `FORCE`, policy `shop_id = app.current_shop_id()`; `bma_app` gets `SELECT, INSERT, UPDATE` (no `DELETE`; `ON DELETE RESTRICT` protects history). |

### 5.8 Phase 2 tables on the same pattern

`users`, `shop_settings`, `plans`, `subscriptions`, `consent_records`, `otp_challenges`,
`refresh_tokens`, `login_index`, `admin_users`, `export_jobs`, `outbox_events`,
`pending_transactions`, `customer_aliases`, `payment_records`,
`payment_promises`, `reminders`, `conversations`, `conversation_messages`, `media_assets`,
`ai_extraction_runs`, `cost_logs`, `period_locks`, `import_jobs`.

Every shop-owned table follows §4: `shop_id NOT NULL`, RLS + `FORCE`, a policy, a composite FK for
cross-row references, and explicit grants. Platform tables (`login_index`, `admin_users`,
`security_events`, `plans`, `rate_tables`) are explicitly listed as exceptions and have no direct
app `SELECT` beyond what the function/projection needs.

## 6. Append-only enforcement

### 6.1 Triggers

```sql
CREATE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON app.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();

CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON app.audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON app.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_mutation();
```

`reject_mutation()` is written so `TG_OP` is `UPDATE`, `DELETE` or `TRUNCATE`; the same function
serves both row and statement triggers. `ERRCODE = 'insufficient_privilege'` (42501) is the same
class as a missing grant, so the application maps it to a generic 403/409 and logs the table/op.

`TRUNCATE` is not filtered by RLS, so the trigger and the missing `TRUNCATE` grant are both
required. The trigger also fires for the table owner; a superuser can disable it, which is outside
the threat model (superuser compromise is R-01/AC-16).

### 6.2 Immutable tenant key

```sql
CREATE FUNCTION app.reject_shop_id_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.shop_id IS DISTINCT FROM OLD.shop_id THEN
    RAISE EXCEPTION 'shop_id is immutable on %', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- applied to every shop-owned table
CREATE TRIGGER ledger_entries_shop_id_immutable
  BEFORE UPDATE ON app.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_shop_id_change();
```

RLS `WITH CHECK` already prevents this for the app role. The trigger is for the owner/migrator and
for future roles, and it makes the rule explicit in the catalog.

### 6.3 Corrections

There is no `UPDATE` or `DELETE` path for a posted ledger row. A correction is a new row:

```text
original:  id=O, entry_type=SALE,   direction=DEBIT,  amount=50000
reversal:  id=R, entry_type=REVERSAL, direction=CREDIT, amount=50000, reverses_entry_id=O
corrected: id=C, entry_type=SALE,   direction=DEBIT,  amount=45000  (optional)
```

The unique partial index allows exactly one reversal per original. A second reversal fails with
`23505`; the service must return the existing reversal, not create another. Reversals and
adjustments are audited with a reason.

### 6.4 `ON DELETE RESTRICT`

`shops` cannot be hard-deleted while ledger or audit rows exist. Shop closure is a soft-delete
(`status='CLOSED'`) plus PII anonymisation, not a `DELETE`. This protects financial history and
avoids a cascade that would erase evidence. `idempotency_keys` uses `CASCADE` because it is not
financial.

## 7. Money constraints

| Rule | Enforcement |
|---|---|
| Integer paise only | `BIGINT`; `10.5`/`'10.5'` fail at the type boundary |
| Non-negative | `CHECK (amount_paise >= 0)`; direction carries the sign |
| Per-entry ceiling | **Configurable constant** `MAX_ENTRY_PAISE` (default `100000000000`, ₹10 crore). Enforced twice: the application validates against the configured value at boot and in Zod; the database has a `CHECK (amount_paise <= 100000000000)` as the hard backstop. Raising the ceiling requires a migration and a config release together, so the two can never drift silently. |
| Currency | `char(3) CHECK (currency = 'INR')` |
| No floats | no `double precision`, `real`, `money` or `numeric` money columns |
| Exact sums | `SUM(bigint)` returns `numeric` as a string; parse with `fromDatabasePaise()` |
| GST | per-line rounding, half-up, in the shared money engine; tax components stored as integer paise |
| Overflow | `fromDatabasePaise` rejects values outside `Number.MAX_SAFE_INTEGER` |

`pg` returns `BIGINT` as a string by default. We do **not** install a global type parser that
converts it to `Number`; that would silently round large values. Every money read goes through
`fromDatabasePaise(value: string | number | bigint): Paise`, which:

1. accepts an integer string or bigint;
2. rejects `"10.5"`, `"1e3"`, an empty string and `NaN`;
3. rejects values outside the safe-integer range;
4. returns a branded `Paise`.

`toDatabasePaise(amount: Paise): string` is used on write, so the driver never sees a JS float.
A test inserts the maximum, reads it back, and asserts the exact string.

## 8. Idempotency constraints

| Table | Constraint | Purpose |
|---|---|---|
| `ledger_entries` | `UNIQUE (shop_id, idempotency_key)` | one posting per request |
| `ledger_entries` | `UNIQUE (shop_id, posting_id, entry_seq)` | no duplicate line in a posting |
| `ledger_entries` | unique partial `(shop_id, reverses_entry_id)` | one reversal per entry |
| `whatsapp_messages` | `UNIQUE (shop_id, wa_message_id)` | Meta retry and replay |
| `idempotency_keys` | `PRIMARY KEY (shop_id, scope, key)` | replay returns the stored response |
| `pending_transactions` | `UNIQUE (shop_id, idempotency_key)` | double-tapped draft |
| `payment_records` | unique partial `(shop_id, provider, provider_ref)` | duplicate UPI reference |
| `outbox_events` | `UNIQUE (shop_id, dedupe_key)` | one send per event |

Rules:

- The service attempts the insert and handles `23505` as "already done", returning the stored
  result. It never does `SELECT` then `INSERT` as the idempotency check; that races.
- A duplicate-key error is mapped to a generic `409`/`200` response; it must not echo the
  conflicting value.
- Idempotency keys are at least 8 characters and at most 200; they are opaque, not sequential.
- Expired generic idempotency rows are deleted by a bounded cleanup job; ledger rows are never
  deleted.

## 9. Query helpers and SQL safety

### 9.1 The `sql` tag

All SQL goes through one reviewed helper:

```ts
// src/db/sql.ts
export interface SqlQuery { readonly text: string; readonly values: readonly unknown[] }
class Identifier { constructor(readonly name: string) {} }

export function id(name: string): Identifier {
  if (!TENANT_TABLES.has(name) && !OTHER_IDENTIFIERS.has(name)) {
    throw new SqlSafetyError(`identifier not allowlisted: ${name}`);
  }
  return new Identifier(name);
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  let text = "";
  const params: unknown[] = [];
  strings.forEach((chunk, index) => {
    text += chunk;
    if (index >= values.length) return;
    const value = values[index];
    if (value instanceof Identifier) {
      text += `"${value.name.replaceAll('"', '""')}"`; // allowlisted, still quoted
    } else {
      params.push(value);
      text += `$${params.length}`;
    }
  });
  return Object.freeze({ text, values: params });
}
```

Usage:

```ts
const q = sql`SELECT id, amount_paise
              FROM ${id("ledger_entries")}
              WHERE shop_id = ${ctx.shopId}
                AND occurred_at >= ${from}
              ORDER BY occurred_at DESC
              LIMIT ${limit}`;
const rows = await tx.query(q);
```

The tag makes it impossible to interpolate a value into the SQL text by accident: a non-identifier
becomes `$n`. Identifiers are allowlisted and quoted. The helper is the only place that builds SQL
text.

### 9.2 Statement guard

`tx.query()` accepts only a `SqlQuery`, never a bare string. Before sending, it checks:

```ts
const ALLOWED = /^(select|insert|update|delete|with)\b/i;
if (!ALLOWED.test(q.text.trimStart())) throw new SqlSafetyError("statement not allowed");
if (q.text.includes(";")) throw new SqlSafetyError("multi-statement SQL is not allowed");
if (q.text.includes("\u0000")) throw new SqlSafetyError("NUL byte in SQL");
```

This blocks `SET`, `RESET`, `DISCARD`, `COPY`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `GRANT`,
`REVOKE`, `VACUUM`, `DO`, `CALL`, `LISTEN`, `NOTIFY`, `PREPARE`, `EXECUTE` through the tenant API.
The internal `withTenant` bootstrap uses `client.query("SELECT set_config(...)", [shopId])`
directly in `src/db/**`, which is the only reviewed exception.

### 9.3 Lint and CI checks

1. **ESLint rule `bma/no-dynamic-sql`** (custom, in `tools/eslint-rules/`): flags any call to a
   `query`/`one`/`many` method where the first argument is a `TemplateLiteral` with expressions, a
   `BinaryExpression` with `+`, or a non-literal identifier outside `src/db/**`. It also flags
   `SET`/`RESET`/`COPY`/DDL string literals in `src/`.
2. **Import boundary:** `eslint-plugin-boundaries` (or `no-restricted-imports`) forbids importing
   `pg` outside `src/db/**`.
3. **CI grep:** a script walks `src/` and fails on `query(` followed by an interpolated template
   outside `src/db/`. It also fails on `"SET "`/`"RESET "`/`"DISCARD "`/`"COPY "` in application
   code.
4. **Unit fixtures:** the lint rule is tested against known-bad snippets, so a rule regression fails
   CI.
5. **Parameterisation test:** a test passes a SQL-injection string as a value and asserts it is
   bound (the query returns the literal row, not an injection effect).
6. **Tenant-context check:** `npm run check:tenant` fails if `set_config`/`SET LOCAL app.` appears
   outside `src/db/tenant.ts`, or if a registered job processor is not wrapped in `withTenant`.
   The script is tested against bad fixtures so a regression in the check itself fails CI.

## 10. Migrations

- Tool: `postgres-migrations` (forward-only, hash-checked, `migrations` table).
- Connection: `MIGRATION_DATABASE_URL` as `bma_migrator`; the API uses `DATABASE_URL` as
  `bma_app`. The API never holds the migrator credentials.
- Each migration runs in a transaction. `CREATE INDEX CONCURRENTLY` cannot run inside a
  transaction; if needed, it is a separate, explicitly reviewed step with its own lock strategy.
- Applied migrations are immutable. Editing one fails the hash check; a fix is a new migration.
- Destructive changes use expand → backfill → contract across releases, with a backup and a
  verification query between steps. No `DROP COLUMN` in the same release that stops writing it.
- CI runs migrations on a fresh database, then the catalog invariant suite, then runs the
  migration again (no-op) and compares the schema hash.
- Migrations never insert application data except reference data (`plans`, `presets`, rate tables)
  from versioned seed files. Seeds are idempotent (`ON CONFLICT DO NOTHING/UPDATE` with a version).

## 11. Connection and network security

| Control | Setting |
|---|---|
| TLS | production `sslmode=verify-full` with a pinned CA; `sslmode=disable/prefer` rejected by env validation |
| Pool | `max = DB_POOL_MAX` (default 20 per instance), `connectionTimeoutMillis = 5000`, `idleTimeoutMillis = 10000`, `maxUses` bounded |
| Timeouts | `statement_timeout=5s`, `lock_timeout=3s`, `idle_in_transaction_session_timeout=10s` for `bma_app` |
| Connection limit | role-level limit (60 app, 10 reporting, 5 migrator) + pool max; alert at 80 % |
| Network | DB/Redis in a private subnet, no public IP, security group only from API/worker/migration job |
| Redis | `rediss://`, ACL user, no public endpoint, `maxmemory-policy noeviction` for queue/rate data |
| Backups | encrypted, separate account/bucket, 35-day retention, restore drill quarterly |
| Logging | `log_connections`, `log_disconnections`, `log_min_duration_statement=500ms`, `pgaudit` if available |
| Health | `SELECT 1` as `bma_app` with a 1 s timeout; never a tenant query |
| Pooler | PgBouncer or a managed pooler in **transaction** mode; `SET LOCAL` only. Statement mode is forbidden because it can split a transaction. Session-level `SET` is forbidden everywhere. |
| Keys | OTP pepper, blind-index key and field-encryption key come from the KMS/secret manager at boot; the database stores only ciphertext, the blind index and `key_version`. Production refuses to start if a key is missing; there is no plaintext fallback. |

`DATABASE_URL` and `MIGRATION_DATABASE_URL` are separate secrets with separate rotation schedules.
The app secret is scoped to one database and one role; it cannot create roles or databases.

## 12. Catalog invariants (tested, not assumed)

The following queries are implemented as tests that fail CI (see `DB-18`, `DB-19`):

```sql
-- Every table with a shop_id must be NOT NULL and RLS-enabled + forced.
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id'
WHERE n.nspname = 'app'
  AND c.relkind = 'r'
  AND (NOT a.attnotnull OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
-- expected: zero rows

-- Every such table must have at least one policy.
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'shop_id'
WHERE n.nspname = 'app'
  AND c.relkind = 'r'
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'app' AND p.tablename = c.relname
  );
-- expected: zero rows

-- Roles must not be superusers or bypass RLS.
SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
FROM pg_roles
WHERE rolname IN ('bma_migrator','bma_app','bma_reporting');
-- expected: all false

-- The app must not be able to mutate append-only tables or run DDL.
SELECT has_table_privilege('bma_app','app.ledger_entries','UPDATE'),   -- false
       has_table_privilege('bma_app','app.ledger_entries','DELETE'),   -- false
       has_table_privilege('bma_app','app.audit_logs','UPDATE'),       -- false
       has_table_privilege('bma_app','app.ledger_entries','TRUNCATE'), -- false
       has_schema_privilege('bma_app','app','CREATE'),                 -- false
       has_database_privilege('bma_app','business_memory','TEMP');     -- false

-- No application key material may live in the database.
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'app'
  AND column_name IN ('otp_pepper','encryption_key','data_key','master_key','blind_index_key',
                      'password_hash','totp_secret');
-- expected: zero rows

-- SECURITY DEFINER functions: owner, pinned search_path, no PUBLIC execute.
SELECT p.proname, r.rolname AS owner, p.proconfig,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'app' AND p.prosecdef;
-- expected: owner = bma_migrator, proconfig contains search_path=pg_catalog, app,
--           public_can_execute = false
```

A new table with `shop_id` that forgets RLS, a policy, `NOT NULL` or the right grants fails the
build. This is the guard against "we added a table in a hurry".

## 13. Residual risk and trade-offs

| Risk | Why it remains | Mitigation |
|---|---|---|
| R-01: GUC spoofing | any code that can run arbitrary SQL as `bma_app` can set `app.shop_id` | parameterization, statement guard, lint rule, least privilege, `pgaudit`, alert on RLS/trigger rejection |
| R-02: OTP pepper | 6-digit space; DB + pepper leak is fatal | secret manager, rotation invalidates OTPs, 5-min TTL, 3 attempts, rate limits |
| R-03: blind index | exact-match only; no partial search on encrypted PII; customer names are unencrypted | documented limitation; support cannot search by partial phone; names remain searchable by explicit decision |
| R-04: fail-closed Redis | OTP, login, refresh and export are blocked during a Redis outage | signed break-glass runbook, not an automatic bypass; existing sessions continue; webhooks persist and degrade |
| R-05: append-only vs erasure | financial rows are retained | anonymise PII per `docs/14-retention-and-anonymisation.md`; legal review; tombstone audit |
| R-06: RESTRICT deletes | shop hard-delete is blocked by history | soft-delete + anonymisation workflow |
| R-07: `SECURITY DEFINER` lookups | a function bug can cross shops | fixed projection, pinned `search_path`, no dynamic SQL, no direct table grant, owner not superuser, caller rate limit, audit, tests |
| R-08: superuser | can bypass everything | not used by the app; break-glass only; credentials in a separate vault; session recording |
| R-09: KMS/secret-manager outage | encrypted fields and OTP cannot be read/verified | fail closed, never fall back to plaintext; cache the wrapped data key in memory for the process lifetime; page on failure |

## 14. Approval record (2026-11-13)

All ten decisions are approved, with the changes below. The DDL and the test plan incorporate them;
this section is the audit trail.

| # | Decision | Approved as | Change |
|---|---|---|---|
| 1 | Roles | `bma_migrator`, `bma_app`, `bma_reporting` + one-time bootstrap | — |
| 2 | Context | `SET LOCAL app.shop_id` via `set_config(..., true)`, fail-closed | add `check:tenant`, worker coverage, transaction-pooler test |
| 3 | Schema | `app`, UUID PKs, `shop_id NOT NULL`, composite FKs, `RESTRICT` | `customers` added to Phase 1 |
| 4 | Money | non-negative + `direction` | ceiling is a configurable constant with a DB backstop |
| 5 | Append-only | row + statement triggers, no mutation grants, one reversal | — |
| 6 | Identity bootstrap | `SECURITY DEFINER` over `login_index` | owner/`search_path`/grant/caller-rate-limit proven by DB-48 |
| 7 | Reporting | `security_invoker` views, no PII | — |
| 8 | Migrations | `postgres-migrations`, forward-only, hash-checked | — |
| 9 | TLS/timeouts | `verify-full`, 5 s / 3 s / 10 s | — |
| 10 | Phase 1 scope | 6 tables, no money routes | **7 tables**: add `customers` for the ledger FK |

Also approved: field encryption for phone/address/notes only (names stay searchable), webhook
persistence before queueing, security tests as `bma_app` only, and keys in the KMS/secret manager.
