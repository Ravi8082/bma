import { withTenant, type TenantDb } from "./db/tenant";
import { sql } from "./db/sql";

export interface CostLogEntry {
  shopId: string;
  provider: string;
  model: string;
  kind: "LLM" | "STT";
  outcome: "SUCCESS" | "FAILED" | "FALLBACK";
  promptTokens?: number;
  completionTokens?: number;
  voiceMinutes?: number;
  costPaise?: number;
}

export async function recordCost(entry: CostLogEntry): Promise<void> {
  try {
    await withTenant({ shopId: entry.shopId, actorType: "SYSTEM", actorId: "cost-log" }, async (db: TenantDb) => {
      await db.execute(
        sql`INSERT INTO app.cost_log
              (shop_id, provider, model, kind, outcome, prompt_tokens, completion_tokens,
               voice_minutes, cost_paise)
            VALUES
              (${entry.shopId}, ${entry.provider}, ${entry.model}, ${entry.kind}, ${entry.outcome},
               ${entry.promptTokens ?? 0}, ${entry.completionTokens ?? 0},
               ${entry.voiceMinutes ?? 0}, ${entry.costPaise ?? 0})`,
      );
    });
  } catch {
    // Cost tracking is non-critical; never break extraction because of it.
  }
}
