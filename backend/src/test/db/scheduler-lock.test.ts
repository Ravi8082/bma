import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { getPool } from "../../config/db";
import { runSchedulerTick, SCHEDULER_LOCK_KEY } from "../../whatsapp/scheduler";
import { deterministicParser } from "../../whatsapp/parser";
import { SimulatorMessagingProvider } from "../../integrations/messaging/simulator";
import { SimulatorStore } from "../../simulator/store";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const store = new SimulatorStore();
const messaging = new SimulatorMessagingProvider(store);
const deps = {
  parser: deterministicParser,
  keyRef: env.FIELD_ENCRYPTION_KEY_REF,
  blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
  messaging,
};

describe("scheduler tick lock", () => {
  it("uses a transaction-scoped advisory lock", async () => {
    const tick = await runSchedulerTick(deps);
    expect(tick.skipped).toBe(false);
  });

  it("returns skipped when the transaction-scoped lock is already held", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const held = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        [SCHEDULER_LOCK_KEY],
      );
      expect(held.rows[0]?.acquired).toBe(true);

      const tick = await runSchedulerTick(deps);
      expect(tick.skipped).toBe(true);
      expect(tick.inboxProcessed).toBe(0);
      expect(tick.outboxProcessed).toBe(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // After the holder commits/rolls back, the next tick acquires the lock. This models
    // a transaction-mode pooler handing the next statement to a different server connection.
    const tick = await runSchedulerTick(deps);
    expect(tick.skipped).toBe(false);
  });

  it("releases the lock when the tick commits", async () => {
    await runSchedulerTick(deps);

    const client = await getPool().connect();
    try {
      const held = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
        [SCHEDULER_LOCK_KEY],
      );
      expect(held.rows[0]?.acquired).toBe(true);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1::bigint)", [SCHEDULER_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  });
});
