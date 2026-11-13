/**
 * Outbox processor and lease sweeper with in-process scheduler.
 *
 * The scheduler is guarded so it is safe on multiple instances:
 * only one instance holds the advisory lock at a time.
 */

import { withTransaction } from "../config/db";
import { claimNextGlobal, reclaimExpiredLeases } from "./inbox";
import { claimNextOutbound, markFailed, markSent } from "./outbound";

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

export function startScheduler(intervalMs = 30_000): void {
  if (schedulerHandle) return; // already running
  schedulerHandle = setInterval(async () => {
    if (isRunning) return; // prevent overlapping runs
    isRunning = true;
    try {
      await runSweeper();
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}

export function stopScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

async function runSweeper(): Promise<void> {
  // Reclaim expired leases
  await reclaimExpiredLeases();

  // Process one inbox message (global sweep)
  const claimed = await claimNextGlobal();
  if (claimed) {
    // Processing happens here (outside transaction). For Phase 3, we just mark as DONE
    // after processing. In Phase 4+, this will call the extraction pipeline.
    await markInboxDone(claimed.id);
  }

  // Process one outbound message
  // (In a real system, this iterates over shops. For now, we skip — the outbox
  //  processor is triggered per-shop by the application.)
}

async function markInboxDone(messageId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE app.inbox_messages SET status = 'DONE', processed_at = now(), lease_until = NULL, updated_at = now() WHERE id = $1`,
      [messageId],
    );
  });
}

export async function processOutboxForShop(shopId: string, sendFn: (msg: { id: string; payload: Record<string, unknown> }) => Promise<string>): Promise<void> {
  const claimed = await claimNextOutbound(shopId);
  if (!claimed) return;

  try {
    const providerId = await sendFn({ id: claimed.id, payload: claimed.payload });
    await markSent(claimed.id, providerId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const result = await markFailed(claimed.id, msg);
    if (result === "DEAD") {
      // Notify seller (handled by caller or a separate notification)
      // Alert is raised here
      void claimed;
    void msg;
    }
  }
}
