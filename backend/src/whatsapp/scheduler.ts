/**
 * Scheduler for the lease sweeper and outbox sender.
 *
 * Safe on multiple instances: one transaction-scoped PostgreSQL advisory lock makes
 * exactly one process run a tick at a time. A transaction-scoped lock is released by
 * COMMIT/ROLLBACK and by connection loss, so it also works behind a transaction-mode
 * pooler where a server connection may be reused between statements. Each item is
 * still claimed with SKIP LOCKED, so a process that stalls cannot block the others.
 */

import { getPool } from "../config/db";
import { runEveningTick } from "./eveningScheduler";
import { listShopIdsWithPendingInbox, listShopIdsWithQueuedOutbox, reclaimExpiredLeases } from "./inbox";
import { processNextInboxMessageForShop, type InboundDeps } from "./inboundRouter";
import { processNextOutboundForShop, type OutboundDeps } from "./outboundSender";

export type SchedulerDeps = InboundDeps & OutboundDeps;

/** Exported so the lock test uses the same key as the production tick. */
export const SCHEDULER_LOCK_KEY = "918273645";
const MAX_ROUNDS = 50;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export interface TickResult {
  skipped: boolean;
  inboxProcessed: number;
  outboxProcessed: number;
  leasesReclaimed: number;
  eveningRuns: number;
}

export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickResult> {
  const client = await getPool().connect();
  let inTransaction = false;

  try {
    await client.query("BEGIN");
    inTransaction = true;
    // The tick holds the lock transaction open while it uses other pooled connections.
    // Do not let a long tick be killed as an idle transaction; the lock disappears with
    // the connection if the process really dies.
    await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");

    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [SCHEDULER_LOCK_KEY],
    );
    if (lock.rows[0]?.acquired !== true) {
      await client.query("ROLLBACK");
      inTransaction = false;
      return {
        skipped: true,
        inboxProcessed: 0,
        outboxProcessed: 0,
        leasesReclaimed: 0,
        eveningRuns: 0,
      };
    }

    const leasesReclaimed = await reclaimExpiredLeases();

    // Queue evening summaries before the outbox drain so a shop whose window is open
    // receives today's summary in this same tick.
    const eveningRuns = (await runEveningTick(deps)).ranShops;

    let inboxProcessed = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const shopIds = await listShopIdsWithPendingInbox();
      if (shopIds.length === 0) break;
      let progressed = false;
      for (const shopId of shopIds) {
        const result = await processNextInboxMessageForShop(shopId, deps);
        if (result.processed) {
          progressed = true;
          inboxProcessed += 1;
        }
      }
      if (!progressed) break;
    }

    let outboxProcessed = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const shopIds = await listShopIdsWithQueuedOutbox();
      if (shopIds.length === 0) break;
      let progressed = false;
      for (const shopId of shopIds) {
        const result = await processNextOutboundForShop(shopId, deps);
        if (result.processed) {
          progressed = true;
          outboxProcessed += 1;
        }
      }
      if (!progressed) break;
    }

    await client.query("COMMIT");
    inTransaction = false;
    return { skipped: false, inboxProcessed, outboxProcessed, leasesReclaimed, eveningRuns };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is about to be released; a failed rollback is not actionable.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

export function startScheduler(deps: SchedulerDeps, intervalMs = 30_000): void {
  if (schedulerHandle) return;
  const tick = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await runSchedulerTick(deps);
    } catch {
      // A failed tick is retried on the next interval; per-item failures are already recorded.
    } finally {
      tickInFlight = false;
    }
  };
  void tick();
  schedulerHandle = setInterval(() => void tick(), intervalMs);
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
