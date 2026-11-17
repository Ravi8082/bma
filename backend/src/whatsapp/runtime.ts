/**
 * Process wiring for the scheduler. Kept out of `server.ts` so tests can construct their own
 * dependencies (a fresh simulator store, a controlled parser) without touching this module.
 */

import { env } from "../config/env";
import { messaging } from "../container";
import { createSttProvider } from "../integrations/speech/factory";
import { deterministicParser } from "./parser";
import type { SchedulerDeps } from "./scheduler";

export function buildSchedulerDeps(): SchedulerDeps {
  const deps: SchedulerDeps = {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging,
    stt: createSttProvider(env.STT_PROVIDER, env.STT_API_KEY),
    sttCostPaisePerMinute: env.STT_COST_PAISE_PER_MINUTE,
  };
  if (env.STT_LANGUAGE) deps.sttLanguageHint = env.STT_LANGUAGE;
  return deps;
}
