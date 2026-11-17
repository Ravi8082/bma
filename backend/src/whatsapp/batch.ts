/**
 * Evening batch: snapshot a set of drafts under a batch id, confirm them all with a
 * per-entry version check, and produce a summary. typeUnclear entries block Confirm all.
 */
import { randomUUID } from "node:crypto";
import { withTenant } from "../db/tenant";
import { sql } from "../db/sql";
import { formatPaise } from "./receipt";
import { confirmDraft, type ConfirmResult } from "./confirmation";
import { serviceWindowOpen } from "./outboundSender";

export interface BatchSnapshot {
  batchId: string;
  shopId: string;
  draftIds: string[];
}

export interface BatchEntryVersion {
  draftId: string;
  version: number;
}

export interface BatchConfirmResult {
  batchId: string;
  confirmed: number;
  skipped: number; // typeUnclear or already-confirmed
  failed: number;
  totalPaise: number;
  results: Array<{ draftId: string; status: string }>;
}

/** Create a batch snapshot: assign a batch id to the given drafts. */
export async function createBatch(shopId: string, draftIds: string[]): Promise<BatchSnapshot> {
  const batchId = randomUUID();
  await withTenant({ shopId, actorType: "USER", actorId: "seller" }, async (db) => {
    for (const id of draftIds) {
      await db.execute(sql`UPDATE app.entry_drafts SET batch_id = ${batchId} WHERE shop_id = ${shopId} AND id = ${id}`);
    }
  });
  return { batchId, shopId, draftIds };
}

/** Read the per-entry version snapshot for a batch. */
export async function batchEntryVersions(shopId: string, batchId: string): Promise<BatchEntryVersion[]> {
  return withTenant({ shopId, actorType: "USER", actorId: "seller" }, async (db) => {
    const rows = await db.query<{ id: string; version: number }>(
      sql`SELECT id, version FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batchId}`,
    );
    return rows.map((r) => ({ draftId: r.id, version: r.version }));
  });
}

/** Confirm all drafts in a batch, with per-entry version check and typeUnclear gate. */
export async function confirmAllBatch(
  shopId: string,
  batchId: string,
  deps: { keyRef: string },
  expectedVersions: Record<string, number>,
): Promise<BatchConfirmResult> {
  const result: BatchConfirmResult = { batchId, confirmed: 0, skipped: 0, failed: 0, totalPaise: 0, results: [] };
  const drafts = await withTenant({ shopId, actorType: "USER", actorId: "seller" }, async (db) => {
    return db.query<{ id: string; version: number; type_unclear: boolean; amount_paise: string; status: string }>(
      sql`SELECT id, version, type_unclear, amount_paise, status FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batchId}`,
    );
  });
  for (const d of drafts) {
    // typeUnclear gate
    if (d.type_unclear) { result.skipped++; result.results.push({ draftId: d.id, status: "TYPE_UNCLEAR" }); continue; }
    if (d.status !== "PENDING") { result.skipped++; result.results.push({ draftId: d.id, status: d.status }); continue; }
    // per-entry version check
    const expected = expectedVersions[d.id];
    if (expected !== undefined && expected !== d.version) { result.failed++; result.results.push({ draftId: d.id, status: "VERSION_MISMATCH" }); continue; }
    const r: ConfirmResult = await confirmDraft(shopId, d.id, { keyRef: deps.keyRef });
    if (r.status === "CONFIRMED") { result.confirmed++; result.totalPaise += Number.parseInt(d.amount_paise, 10); }
    else if (r.status === "TYPE_UNCLEAR") { result.skipped++; }
    else { result.failed++; }
    result.results.push({ draftId: d.id, status: r.status });
  }
  return result;
}

/** Paged review of a batch's entries. */
export async function reviewBatchPage(shopId: string, batchId: string, page: number, pageSize: number): Promise<{ entries: Array<{ id: string; amount_paise: string; type_unclear: boolean; status: string; customer_name: string; entry_type: string }>; total: number }> {
  return withTenant({ shopId, actorType: "USER", actorId: "seller" }, async (db) => {
    const rows = await db.query<{ id: string; amount_paise: string; type_unclear: boolean; status: string; customer_name: string; entry_type: string }>(
      sql`SELECT id, amount_paise, type_unclear, status, customer_name, entry_type FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batchId} ORDER BY created_at LIMIT ${pageSize} OFFSET ${page * pageSize}`,
    );
    const cnt = await db.query<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batchId}`);
    return { entries: rows, total: Number(cnt[0]?.c ?? 0) };
  });
}

export interface EveningSummaryDeps {
  messaging: { sendText: (a: { to: string; text: string }) => Promise<unknown>; sendTemplate: (a: { to: string; templateName: string; language: string; bodyParameters: string[] }) => Promise<unknown> };
  keyRef: string;
  templateName?: string;
}

/** Send the evening summary: template (with quick-reply) if the 24h window is closed and a template is available, otherwise plain text. If no template and window closed, stays queued. */
export async function sendEveningSummary(shopId: string, batchId: string, recipientPhone: string, recipientBidx: Buffer, deps: EveningSummaryDeps): Promise<"sent" | "queued"> {
  const drafts = await withTenant({ shopId, actorType: "USER", actorId: "seller" }, async (db) => {
    return db.query<{ amount_paise: string; status: string }>(sql`SELECT amount_paise, status FROM app.entry_drafts WHERE shop_id = ${shopId} AND batch_id = ${batchId}`);
  });
  const pending = drafts.filter((d) => d.status === "PENDING");
  const totalPaise = pending.reduce((a, d) => a + Number.parseInt(d.amount_paise, 10), 0);
  const text = `Evening summary: ${pending.length} entries, total ${formatPaise(totalPaise)}.`;

  const windowOpen = await serviceWindowOpen(shopId, recipientBidx);
  if (windowOpen) {
    await deps.messaging.sendText({ to: recipientPhone, text });
    return "sent";
  }
  if (deps.templateName) {
    await deps.messaging.sendTemplate({ to: recipientPhone, templateName: deps.templateName, language: "en", bodyParameters: [text] });
    return "sent";
  }
  // No template available: stay queued.
  return "queued";
}

/** Scheduler entry point: create a batch from pending drafts and send the summary. Does NOT post ledger rows. */
export async function scheduleEveningBatch(shopId: string, draftIds: string[], recipientPhone: string, recipientBidx: Buffer, deps: EveningSummaryDeps): Promise<{ batchId: string; sendResult: "sent" | "queued" }> {
  const batch = await createBatch(shopId, draftIds);
  const sendResult = await sendEveningSummary(shopId, batch.batchId, recipientPhone, recipientBidx, deps);
  return { batchId: batch.batchId, sendResult };
}