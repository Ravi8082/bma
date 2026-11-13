/**
 * The only way application code builds SQL.
 *
 * Values are always bound (`$1`, `$2`, …). Identifiers cannot be interpolated as
 * text: they must go through `id()`, which checks an allowlist and quotes the
 * name. The result is an immutable `SqlQuery` that the tenant transaction
 * executes after a statement guard has run.
 *
 * This file imports nothing from `pg`; it is pure text construction so it can be
 * unit-tested without a database.
 */

export class SqlSafetyError extends Error {
  readonly code = "SQL_SAFETY_VIOLATION";

  constructor(message: string) {
    super(message);
    this.name = "SqlSafetyError";
  }
}

/**
 * Identifiers that may appear dynamically in a query.
 *
 * Every table and every column that a query helper interpolates must be listed
 * here. Adding a name is a reviewed change; a typo fails loudly instead of
 * producing a valid query against the wrong object.
 */
const ALLOWED_IDENTIFIERS: ReadonlySet<string> = new Set([
  // tables
  "shops",
  "shop_settings",
  "customers",
  "ledger_entries",
  "whatsapp_messages",
  "idempotency_keys",
  "audit_logs",
  "security_events",
  "migrations",
  "users",
  "plans",
  "subscriptions",
  "consent_records",
  "onboarding_state",
  "phone_change_requests",
  "helper_assignments",
  "export_requests",
  "deletion_requests",
  "login_index",
  // columns used by generic helpers
  "id",
  "shop_id",
  "customer_id",
  "posting_id",
  "entry_type",
  "direction",
  "amount_paise",
  "occurred_at",
  "created_at",
  "updated_at",
  "status",
  "version",
  "name",
  "name_normalized",
  "phone_enc",
  "phone_bidx",
  "address_enc",
  "notes_enc",
  "key_version",
  "balance_paise",
  "opted_out_at",
  "merged_into_id",
  "last_transaction_at",
  "wa_message_id",
  "wa_conversation_id",
  "from_phone_bidx",
  "to_phone_bidx",
  "message_type",
  "body",
  "raw_payload",
  "body_hash",
  "received_at",
  "processed_at",
  "error",
  "idempotency_key",
  "request_hash",
  "response_status",
  "response_body",
  "expires_at",
  "actor_type",
  "actor_id",
  "action",
  "entity_type",
  "entity_id",
  "detail",
  "request_id",
  "ip",
  "kind",
  "severity",
  "user_agent_hash",
  "preset_key",
  "presets_version",
  "visible_modules",
  "vocabulary_hints",
  "default_report",
  "template_set",
  "units",
  "role",
  "status",
  "plan_key",
  "trial_days",
  "features",
  "plan_id",
  "trial_ends_at",
  "current_period_start",
  "current_period_end",
  "purpose",
  "granted",
  "policy_version",
  "method",
  "evidence_message_id",
  "granted_at",
  "conversation_id",
  "state",
  "shop_name",
  "invalid_count",
  "last_message_id",
  "old_phone_bidx",
  "new_phone_enc",
  "new_phone_bidx",
  "new_key_version",
  "effective_at",
  "cancelled_at",
  "helper_user_id",
  "owner_user_id",
  "confirmed_at",
  "download_token",
  "download_expires_at",
  "downloaded_at",
  "cooling_off_ends_at",
  "flag_name",
  "enabled",
  "override",
]);

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

class SqlIdentifier {
  readonly name: string;

  constructor(name: string) {
    if (typeof name !== "string" || !IDENTIFIER_PATTERN.test(name)) {
      throw new SqlSafetyError(
        `identifier ${JSON.stringify(String(name))} must be a lowercase SQL name`,
      );
    }
    if (!ALLOWED_IDENTIFIERS.has(name)) {
      throw new SqlSafetyError(
        `identifier "${name}" is not allowlisted; add it to ALLOWED_IDENTIFIERS in src/db/sql.ts`,
      );
    }
    this.name = name;
  }
}

/** Mark a value as a SQL identifier. Values never take this path. */
export function id(name: string): SqlIdentifier {
  return new SqlIdentifier(name);
}

export type SqlPrimitive = string | number | bigint | boolean | Date | Buffer | null;
export type SqlBindValue = SqlPrimitive | readonly SqlPrimitive[];

export interface SqlQuery {
  readonly text: string;
  readonly values: readonly SqlBindValue[];
}

export type SqlPart = SqlIdentifier | SqlBindValue | undefined;

function normaliseBind(part: SqlBindValue | undefined): SqlBindValue {
  if (part === undefined) {
    // An undefined bind is almost always a bug. Sending it as NULL hides it.
    throw new SqlSafetyError("undefined is not a valid query parameter; use null explicitly");
  }
  if (part === null) return null;

  if (typeof part === "string") {
    if (part.includes("\u0000")) throw new SqlSafetyError("NUL byte in a string parameter");
    return part;
  }

  if (typeof part === "number") {
    if (!Number.isFinite(part)) {
      throw new SqlSafetyError(`non-finite number parameter ${String(part)}`);
    }
    return part;
  }

  if (typeof part === "bigint" || typeof part === "boolean") return part;
  if (part instanceof Date) {
    if (Number.isNaN(part.getTime())) throw new SqlSafetyError("invalid Date parameter");
    return part;
  }
  if (Buffer.isBuffer(part)) return part;
  if (part instanceof Uint8Array) return Buffer.from(part);
  if (Array.isArray(part)) {
    return part.map((item) => {
      if (item !== null && typeof item === "object") {
        throw new SqlSafetyError("array parameters may contain only scalar values");
      }
      return normaliseScalar(item);
    });
  }

  throw new SqlSafetyError(
    `unsupported parameter type ${Object.prototype.toString.call(part)}; bind a scalar, Date, Buffer or array`,
  );
}

function normaliseScalar(value: SqlPrimitive | undefined): SqlPrimitive {
  if (value === undefined) {
    throw new SqlSafetyError("undefined is not a valid array element; use null explicitly");
  }
  if (value === null) return null;
  if (typeof value === "string" && value.includes("\u0000")) {
    throw new SqlSafetyError("NUL byte in a string parameter");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new SqlSafetyError(`non-finite number parameter ${String(value)}`);
  }
  return value;
}

const ALLOWED_STATEMENT = /^(select|insert|update|delete|with)\b/i;
const MAX_SQL_LENGTH = 100_000;

/**
 * Reject anything that is not a single DML statement.
 *
 * A leading keyword allowlist blocks `SET`, `RESET`, DDL and `COPY`; the
 * semicolon ban blocks a second statement. Comments are not stripped: a
 * semicolon inside a comment is still a rejection, which is stricter than
 * necessary and safer.
 */
export function assertSafeStatement(query: SqlQuery): void {
  if (typeof query?.text !== "string") {
    throw new SqlSafetyError("query text must be a string");
  }
  if (query.text.length > MAX_SQL_LENGTH) {
    throw new SqlSafetyError(`query text exceeds ${MAX_SQL_LENGTH} characters`);
  }
  if (query.text.includes("\u0000")) {
    throw new SqlSafetyError("NUL byte in SQL");
  }
  if (query.text.includes(";")) {
    throw new SqlSafetyError("multi-statement SQL is not allowed");
  }
  if (!ALLOWED_STATEMENT.test(query.text.trimStart())) {
    throw new SqlSafetyError(
      "statement not allowed: only SELECT, INSERT, UPDATE, DELETE and WITH are permitted",
    );
  }
  if (!Array.isArray(query.values)) {
    throw new SqlSafetyError("query values must be an array");
  }
}

/**
 * Tagged template for parameterised SQL.
 *
 *   sql`SELECT id FROM ${id("shops")} WHERE shop_id = ${shopId}`
 *
 * A non-identifier interpolation becomes a bind parameter; identifiers are
 * allowlisted and double-quoted. The text is validated before it is returned,
 * so an invalid statement fails where it is written, not when a connection is
 * already checked out.
 */
export function sql(strings: TemplateStringsArray, ...parts: readonly SqlPart[]): SqlQuery {
  if (!Array.isArray(strings) || !Array.isArray(parts)) {
    throw new SqlSafetyError("sql must be used as a tagged template literal");
  }
  if (parts.length !== strings.length - 1) {
    throw new SqlSafetyError("sql tag received a mismatched number of interpolations");
  }

  let text = "";
  const values: SqlBindValue[] = [];

  for (let index = 0; index < strings.length; index += 1) {
    text += strings[index] ?? "";
    if (index >= parts.length) continue;

    const part = parts[index];
    if (part instanceof SqlIdentifier) {
      text += `"${part.name}"`;
      continue;
    }
    values.push(normaliseBind(part));
    text += `$${values.length}`;
  }

  const query = Object.freeze({
    text,
    values: Object.freeze(values),
  });
  assertSafeStatement(query);
  return query;
}
