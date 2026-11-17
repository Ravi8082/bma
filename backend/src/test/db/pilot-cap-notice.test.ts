import { describe, expect, it } from "vitest";
import { env } from "../../config/env";
import { claimPilotCapNotice, PILOT_CAP_MESSAGE } from "../../whatsapp/pilotBudget";
import { seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

describe("pilot-cap notice idempotency", () => {
  it("claims the notice only once per period", async () => {
    const shop = await seedShop({ pilotDailyCapPaise: 1_000, pilotMonthlyCapPaise: 100_000 });
    const breach = {
      dayPaise: 2_000,
      monthPaise: 2_000,
      cap: "DAY" as const,
      period: new Date().toISOString().slice(0, 10),
    };
    const first = await claimPilotCapNotice(shop.shopId, breach);
    const second = await claimPilotCapNotice(shop.shopId, breach);
    expect(first).toBe(true);
    expect(second).toBe(false);
    void env;
    void PILOT_CAP_MESSAGE;
  });
});
