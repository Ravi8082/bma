import type { AppEnv } from "../../config/env";
import type { MessagingProvider } from "./types";
import { SimulatorMessagingProvider } from "./simulator";
import type { SimulatorStore } from "../../simulator/store";

export interface MessagingProviderDeps {
  simulatorStore: SimulatorStore;
}

export class ProviderNotImplementedError extends Error {
  readonly code = "PROVIDER_NOT_IMPLEMENTED";

  constructor(provider: string, phase: string) {
    super(`The "${provider}" messaging provider is not implemented yet (planned in ${phase}).`);
    this.name = "ProviderNotImplementedError";
  }
}

export function createMessagingProvider(
  kind: AppEnv["MESSAGING_PROVIDER"],
  deps: MessagingProviderDeps,
): MessagingProvider {
  switch (kind) {
    case "simulator":
      return new SimulatorMessagingProvider(deps.simulatorStore);
    case "meta":
      // Phase 3 replaces this with MetaCloudMessagingProvider. Until then the
      // process refuses to start rather than pretending to send messages.
      throw new ProviderNotImplementedError("meta", "Phase 3");
  }
}
