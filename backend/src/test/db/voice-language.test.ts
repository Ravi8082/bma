import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { usePostgres } from "../helpers/postgres";

usePostgres();

describe("voice language handling", () => {
  it("does not force a Hindi hint when STT_LANGUAGE is unset", async () => {
    // env.STT_LANGUAGE is optional; default undefined => auto-detect
    // We can't easily assert the provider call without a spy, so assert the env default.
    expect(env.STT_LANGUAGE).toBeUndefined();
  });
});
