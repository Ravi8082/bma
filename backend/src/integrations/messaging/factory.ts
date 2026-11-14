import type { AppEnv } from "../../config/env";
import type { MessagingProvider } from "./types";
import { SimulatorMessagingProvider } from "./simulator";
import type { SimulatorStore } from "../../simulator/store";
import { MetaCloudMessagingProvider } from "./meta";

export interface MessagingProviderDeps {
  simulatorStore: SimulatorStore;
  meta?: {
    accessToken?: string;
    phoneNumberId?: string;
    baseUrl?: string;
    fetchImpl?: typeof fetch;
  };
}

export class ProviderNotImplementedError extends Error {
  readonly code = "PROVIDER_NOT_IMPLEMENTED";

  constructor(provider: string, phase: string) {
    super(`The "${provider}" messaging provider is not implemented yet (planned in ${phase}).`);
    this.name = "ProviderNotImplementedError";
  }
}

export class MetaConfigurationError extends Error {
  readonly code = "META_CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "MetaConfigurationError";
  }
}

export function createMessagingProvider(
  kind: AppEnv["MESSAGING_PROVIDER"],
  deps: MessagingProviderDeps,
): MessagingProvider {
  switch (kind) {
    case "simulator":
      return new SimulatorMessagingProvider(deps.simulatorStore);
    case "meta": {
      const accessToken = deps.meta?.accessToken ?? undefined;
      const phoneNumberId = deps.meta?.phoneNumberId ?? undefined;
      if (!accessToken || !phoneNumberId) {
        throw new MetaConfigurationError(
          "meta provider requires an access token and phone number id",
        );
      }
      return new MetaCloudMessagingProvider({
        accessToken,
        phoneNumberId,
        ...(deps.meta?.baseUrl ? { baseUrl: deps.meta.baseUrl } : {}),
        ...(deps.meta?.fetchImpl ? { fetchImpl: deps.meta.fetchImpl } : {}),
      });
    }
  }
}
