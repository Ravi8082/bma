import { env } from "./config/env";
import { InlineQueue } from "./jobs/queue";
import { SimulatorStore } from "./simulator/store";
import { createMessagingProvider } from "./integrations/messaging/factory";
import { TenantScopedProcessorRegistry } from "./jobs/processors/registry";

/**
 * Process-wide singletons. Explicit and boring on purpose: with one API
 * process, a dependency-injection container would add indirection without
 * buying testability (tests construct their own instances).
 */
export const simulatorStore = new SimulatorStore();
const metaConfig = {
  ...(env.WHATSAPP_ACCESS_TOKEN ? { accessToken: env.WHATSAPP_ACCESS_TOKEN } : {}),
  ...(env.WHATSAPP_PHONE_NUMBER_ID ? { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID } : {}),
  baseUrl: env.WHATSAPP_GRAPH_BASE_URL,
};
export const messaging = createMessagingProvider(env.MESSAGING_PROVIDER, {
  simulatorStore,
  meta: metaConfig,
});
export const queue = new InlineQueue();
export const processors = new TenantScopedProcessorRegistry();
