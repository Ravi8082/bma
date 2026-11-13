# 09 — How paise are stored in PostgreSQL

## The rule

Every INR amount is an **integer number of paise**, stored in a `BIGINT` column whose name ends in
`_paise`. Amounts are **non-negative**; the sign lives in a separate `direction` column
(`DEBIT`/`CREDIT`). No floats, no `NUMERIC` money, no rupees at rest, no `Decimal128`.

```
1 rupee   = 100 paise
₹10 crore = 100_000_000_000 paise   (the per-entry ceiling, MAX_ENTRY_PAISE)
```

`BIGINT` holds up to 9,223,372,036,854,775,807. The application is stricter: money is a JavaScript
`number` in the shared engine, so every value must stay within `Number.MAX_SAFE_INTEGER`
(9,007,199,254,740,991 paise ≈ ₹90 trillion). The per-entry ceiling is far below both limits.

## Why not `NUMERIC` or a float

- `NUMERIC` is exact, but every read needs a decimal parser and every service must agree on scale.
  It also invites two money representations (numeric in SQL, number in JS) and silent `ROUND`
  differences.
- `double precision` is exact only for integers up to 2^53 and is a trap for currency.
- `BIGINT` maps to an integer in every language, and `SUM(bigint)` in PostgreSQL returns `NUMERIC`,
  which is exact and has no floating-point residue.

`pg` returns `BIGINT` as a **string** by default. We keep that behaviour: installing a global type
parser that turns every `BIGINT` into a JS `Number` would silently round large values.

## Write path (four layers)

1. `shared/money` — `paise()`, `fromRupees()` and arithmetic reject fractions, `NaN`, `Infinity`
   and unsafe integers. Parsing uses string/BigInt maths, so `0.1 + 0.2` never appears.
2. Zod API schemas — `z.number().int().safe().min(0)` on every `*Paise` field.
3. Service — `toDatabasePaise(amount)` returns a decimal string, never a float.
4. PostgreSQL — `BIGINT NOT NULL` plus a `CHECK`:
   `amount_paise >= 0 AND amount_paise <= 100000000000`.

A direct `INSERT` of `'10.5'` fails at the `BIGINT` input boundary; `10.5` sent as a JS number is
serialized by `pg` as `"10.5"` and fails the same way. It is not rounded.

## Read path

Every money read goes through:

```ts
fromDatabasePaise(value: string | number | bigint): Paise
```

It accepts an integer string or bigint, rejects `"10.5"`, `"1e3"`, an empty string and `NaN`, and
rejects values outside the safe-integer range. `toRupees()` exists **only** for display DTOs; its
result never re-enters arithmetic.

## Aggregation rules

| Allowed | Not allowed |
|---|---|
| `SUM(amount_paise)` (returns `numeric`, exact) | `SUM` mixing paise and rupee columns |
| `SUM(CASE direction WHEN 'DEBIT' THEN amount_paise ELSE -amount_paise END)` | `AVG` stored as money (display only) |
| `MIN`, `MAX`, `COUNT`, `GROUP BY` | `amount_paise::double precision` |
| `FILTER (WHERE ...)` for debit/credit totals | multiplying by a rupee literal (use basis points) |

`SUM(bigint)` returns `NUMERIC`; `pg` returns it as a string. Parse with `fromDatabasePaise` and
assert it is an integer. A nightly reconciliation job compares cached balances with the ledger sum
and alerts on any mismatch.

## Constraints

| Table | Constraint |
|---|---|
| `ledger_entries` | `amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0 AND amount_paise <= 100000000000)` |
| `ledger_entries` | `currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR')` |
| `ledger_entries` | `direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT'))` |
| GST lines (Phase 5) | `taxable_paise`, `cgst_paise`, `sgst_paise`, `igst_paise`, `total_paise` all `BIGINT` with non-negative checks and `total = taxable + cgst + sgst + igst` |

GST is calculated per line, half-up, in the shared engine. The CGST/SGST split comes from the
document total: `cgst = round_half_up(tax / 2)`, `sgst = tax - cgst`. Stored components are exact
integers.

## Proof (tests)

`backend/src/test/moneyPostgres.test.ts` (implemented after approval):

- a stored `100000000000` reads back exactly, as a string;
- `SUM` over 1,000 maximum entries returns exactly `100000000000000`;
- `SUM` of mixed debit/credit is exact (`50000 - 20000 - 1 = 29999`);
- `10.5`, `'10.5'`, `NaN`, `Infinity`, a negative amount and an over-ceiling amount are rejected;
- per-direction and per-category grouping is exact and shop-scoped;
- `fromDatabasePaise("10.5")` and `fromDatabasePaise("9007199254740993")` throw.

## Backups and exports

`pg_dump` preserves `BIGINT` exactly. CSV/XLSX exports format via `formatINR()` and write amounts as
text or integers, never as a float cell. A restore drill compares row counts and a checksum of
`ledger_entries.amount_paise` per shop.

## What would change the decision

If a future module needs sub-paise precision (for example per-unit costing with four decimals), it
adds a separate **rate** column in integer units per 1,000 (or basis points), not a float and not a
different money type. The ledger itself stays integer paise.
