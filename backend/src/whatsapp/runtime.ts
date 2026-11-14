/**
 * Process wiring for the scheduler. Kept out of `server.ts` so tests can construct their own
 * dependencies (a fresh simulator store, a controlled parser) without touching this module.
 */

import { env } from "../config/env";
import { messaging } from "../container";
import { deterministicParser } from "./parser";
import type { SchedulerDeps } from "./scheduler";

export function buildSchedulerDeps(): SchedulerDeps {
  return {
    parser: deterministicParser,
    keyRef: env.FIELD_ENCRYPTION_KEY_REF,
    blindIndexKey: env.PHONE_BLIND_INDEX_KEY,
    messaging,
  };
}
