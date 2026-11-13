import { env } from "./config/env";
import { InlineQueue } from "./jobs/queue";
import { SimulatorStore } from "./simulator/store";
import { createMessagingProvider } from "./integrations/messaging/factory";

/**
 * Process-wide singletons. Explicit and boring on purpose: with one API
 * process, a dependency-injection container would add indirection without
 * buying testability (tests construct their own instances).
 */
export const simulatorStore = new SimulatorStore();
export const messaging = createMessagingProvider(env.MESSAGING_PROVIDER, { simulatorStore });
export const queue = new InlineQueue();
