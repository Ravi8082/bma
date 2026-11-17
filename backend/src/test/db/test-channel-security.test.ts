import { describe, expect, it } from "vitest";
import { isTestChannelEnabled } from "../../testChannel/routes";
import { TestChannelStore } from "../../testChannel/store";
import { usePostgres } from "../helpers/postgres";

usePostgres();

describe("test-channel security regressions", () => {
  it("is disabled in production unless TEST_CHANNEL is set", () => {
    expect(isTestChannelEnabled({ nodeEnv: "production", enabled: false })).toBe(false);
    expect(isTestChannelEnabled({ nodeEnv: "production", enabled: true })).toBe(true);
    expect(isTestChannelEnabled({ nodeEnv: "development", enabled: false })).toBe(true);
    expect(isTestChannelEnabled({ nodeEnv: "test", enabled: false })).toBe(true);
  });

  it("rejects an expired one-time code", () => {
    const store = new TestChannelStore();
    const issued = store.issueCode("00000000-0000-0000-0000-000000000000", "+919876543210", 1, Date.now() - 10);
    expect(store.redeemCode(issued.code, Date.now())).toBeNull();
  });

  it("expires a session after its TTL", () => {
    const store = new TestChannelStore();
    const session = store.createSession("00000000-0000-0000-0000-000000000000", "+919876543210", 1, Date.now() - 10);
    expect(store.getSession(session.token, Date.now())).toBeNull();
  });

  it("rate-limits per session token", () => {
    const store = new TestChannelStore();
    const session = store.createSession("00000000-0000-0000-0000-000000000000", "+919876543210", 60_000);
    expect(store.allowSend(session.token, 2, 60_000)).toBe(true);
    expect(store.allowSend(session.token, 2, 60_000)).toBe(true);
    expect(store.allowSend(session.token, 2, 60_000)).toBe(false);
  });
});
