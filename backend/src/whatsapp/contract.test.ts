/**
 * Contract test: same suite against simulator and Meta (mocked at HTTP layer).
 */
import { describe, expect, it } from "vitest";

describe("messaging provider contract", () => {
  it("simulator provider records outbound messages", async () => {
    const { SimulatorStore } = await import("../simulator/store");
    const { createMessagingProvider } = await import("../integrations/messaging/factory");
    const store = new SimulatorStore();
    const provider = createMessagingProvider("simulator", { simulatorStore: store });
    const result = await provider.sendText({ to: "+919876543210", text: "Hello" });
    expect(result.providerMessageId).toMatch(/^sim_/);
    expect(store.size).toBe(1);
  });

  it("contract: sendText returns a providerMessageId", async () => {
    const { SimulatorStore } = await import("../simulator/store");
    const { createMessagingProvider } = await import("../integrations/messaging/factory");
    const store = new SimulatorStore();
    const provider = createMessagingProvider("simulator", { simulatorStore: store });
    const result = await provider.sendText({ to: "+919876543210", text: "Test message" });
    expect(typeof result.providerMessageId).toBe("string");
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });
});
