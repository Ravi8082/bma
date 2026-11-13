import { describe, expect, it } from "vitest";
import { assertSafeStatement, id, sql, SqlSafetyError } from "./sql";

describe("sql tagged template", () => {
  it("binds injection payloads as values rather than SQL text", () => {
    const payload = "x'; DROP TABLE app.ledger_entries; --";
    const query = sql`SELECT id FROM app.customers WHERE name = ${payload}`;

    expect(query.text).toBe("SELECT id FROM app.customers WHERE name = $1");
    expect(query.values).toEqual([payload]);
    expect(query.text).not.toContain(payload);
  });

  it("quotes only allowlisted identifiers", () => {
    const query = sql`SELECT ${id("id")} FROM app.${id("customers")} WHERE ${id("shop_id")} = ${"shop"}`;
    expect(query.text).toBe('SELECT "id" FROM app."customers" WHERE "shop_id" = $1');
    expect(query.values).toEqual(["shop"]);
    expect(() => id("customers; DROP TABLE shops")).toThrow(SqlSafetyError);
    expect(() => id("not_a_table")).toThrow(/allowlisted/);
  });

  it("rejects multi-statement, DDL and session-control query objects", () => {
    expect(() => assertSafeStatement({ text: "SELECT 1; DELETE FROM app.shops", values: [] })).toThrow(
      /multi-statement/,
    );
    expect(() => assertSafeStatement({ text: "DROP TABLE app.shops", values: [] })).toThrow(
      /statement not allowed/,
    );
    expect(() => assertSafeStatement({ text: "SET app.shop_id = 'x'", values: [] })).toThrow(
      /statement not allowed/,
    );
  });

  it("rejects undefined and non-finite bind values", () => {
    expect(() => sql`SELECT ${undefined}`).toThrow(/undefined/);
    expect(() => sql`SELECT ${Number.NaN}`).toThrow(/non-finite/);
  });
});
