/**
 * Scheduler for the lease sweeper and outbox sender.
 *
 * Safe on multiple instances: a session-level PostgreSQL advisory lock makes exactly one
 * process run a tick at a time. Each item is still claimed with SKIP LOCKED, so a process
 * that stalls cannot block the others after its lock is released.
 */

import { getPool } from "../config/db";
import { listShopIdsWithPendingInbox, listShopIdsWithQueuedOutbox, reclaimExpiredLeases } from "./inbox";
import { processNextInboxMessageForShop, type InboundDeps } from "./inboundRouter";
import { processNextOutboundForShop, type OutboundDeps } from "./outboundSender";

export type SchedulerDeps = InboundDeps & OutboundDeps;

const SCHEDULER_LOCK_KEY = "918273645";
const MAX_ROUNDS = 50;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export interface TickResult {
  skipped: boolean;
  inboxProcessed: number;
  outboxProcessed: number;
  leasesReclaimed: number;
}

export async function runSchedulerTick(deps: SchedulerDeps): Promise<TickResult> {
  const client = await getPool().connect();
  let acquired = false;
  let leasesReclaimed = 0;
  let inboxProcessed = 0;
  let outboxProcessed = 0;

  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [SCHEDULER_LOCK_KEY],
    );
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) return { skipped: true, inboxProcessed: 0, outboxProcessed: 0, leasesReclaimed: 0 };

    leasesReclaimed = await reclaimExpiredLeases();

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

    return { skipped: false, inboxProcessed, outboxProcessed, leasesReclaimed };
  } finally {
    if (acquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [SCHEDULER_LOCK_KEY]);
      } catch {
        // The connection is about to be released; a failed unlock is not actionable here.
      }
    }
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
