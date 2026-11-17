import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { sql } from "../../db/sql";
import { queryWithoutTenant } from "../../db/tenant";
import { simulatorStore } from "../../container";
import { createTestChannelRouter } from "../../testChannel/routes";
import { TestChannelStore } from "../../testChannel/store";
import { errorHandler } from "../../middleware/error";
import { seedShop } from "../helpers/seed";
import { usePostgres } from "../helpers/postgres";

usePostgres();

const ADMIN_TOKEN = "test-admin-token-1234567890abcdef";

describe("web chat test channel", () => {
  let shop: Awaited<ReturnType<typeof seedShop>>;
  let store: TestChannelStore;
  let app: express.Express;

  beforeEach(async () => {
    store = new TestChannelStore();
    simulatorStore.reset();
    shop = await seedShop();
    app = express();
    app.use(express.json());
    app.use("/test-channel", createTestChannelRouter({ enabled: true, store, adminToken: ADMIN_TOKEN, rateLimitPerMinute: 2 }));
    app.use(errorHandler);
  });

  async function issueCode(): Promise<string> {
    const res = await request(app).post("/test-channel/admin/codes").set("x-test-channel-admin-token", ADMIN_TOKEN).send({ shopId: shop.shopId, phone: shop.phone });
    expect(res.status).toBe(201);
    return res.body.data.code as string;
  }

  async function redeem(code: string): Promise<string> {
    const res = await request(app).post("/test-channel/session").send({ code });
    expect(res.status).toBe(201);
    const cookie = res.headers["set-cookie"]?.[0] as string;
    expect(cookie).toBeTruthy();
    return cookie.split(";")[0] ?? "";
  }

  it("rejects admin code issuance with a bad token", async () => {
    const res = await request(app).post("/test-channel/admin/codes").set("x-test-channel-admin-token", "wrong").send({ shopId: shop.shopId, phone: shop.phone });
    expect(res.status).toBe(401);
  });

  it("redeems a one-time code into a session cookie", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    expect(cookie).toContain("bma_test_channel=");
    const second = await request(app).post("/test-channel/session").send({ code });
    expect(second.status).toBe(401);
  });

  it("requires a session for inbox and message endpoints", async () => {
    expect((await request(app).get("/test-channel/messages")).status).toBe(401);
    expect((await request(app).post("/test-channel/messages").send({ text: "hi" })).status).toBe(401);
  });

  it("persists an inbound message before returning 201", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    const res = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ text: "Ramesh 300 udhaar", clientMessageId: "m1" });
    expect(res.status).toBe(201);
    expect(res.body.data.persisted).toBe(true);
    const rows = await queryWithoutTenant<{ id: string }>(sql`SELECT id FROM app.inbox_messages WHERE shop_id = ${shop.shopId} AND wa_message_id = 'tc_m1'`);
    expect(rows).toHaveLength(1);
  });

  it("reports a duplicate id without a second row", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    const first = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ text: "Ramesh 300 udhaar", clientMessageId: "dup" });
    expect(first.status).toBe(201);
    expect(first.body.data.persisted).toBe(true);
    const second = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ text: "Ramesh 300 udhaar", clientMessageId: "dup" });
    expect(second.status).toBe(201);
    expect(second.body.data.persisted).toBe(false);
    const rows = await queryWithoutTenant<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM app.inbox_messages WHERE shop_id = ${shop.shopId} AND wa_message_id = 'tc_dup'`);
    expect(Number(rows[0]?.c ?? "0")).toBe(1);
  });

  it("accepts a contact share", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    const res = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ contact: { name: "Ramesh", phone: "+919876543210" }, clientMessageId: "c1" });
    expect(res.status).toBe(201);
    const rows = await queryWithoutTenant<{ message_type: string }>(sql`SELECT message_type FROM app.inbox_messages WHERE shop_id = ${shop.shopId} AND wa_message_id = 'tc_c1'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_type).toBe("CONTACT");
  });

  it("returns button and list rows from the simulator inbox", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    simulatorStore.add({ to: shop.phone, kind: "BUTTONS", body: "Confirm?", buttons: [{ id: "confirm:1", title: "Confirm" }] });
    simulatorStore.add({ to: shop.phone, kind: "LIST", body: "Pick", rows: [{ id: "row:1", title: "Option A", description: "desc" }] });
    const res = await request(app).get("/test-channel/messages").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const kinds = res.body.data.map((m: { kind: string }) => m.kind);
    expect(kinds).toContain("BUTTONS");
    expect(kinds).toContain("LIST");
    const buttonMsg = res.body.data.find((m: { kind: string }) => m.kind === "BUTTONS");
    expect(buttonMsg.buttons).toEqual([{ id: "confirm:1", title: "Confirm" }]);
    const listMsg = res.body.data.find((m: { kind: string }) => m.kind === "LIST");
    expect(listMsg.rows).toEqual([{ id: "row:1", title: "Option A", description: "desc" }]);
  });

  it("returns 429 after the rate limit is exceeded", async () => {
    const code = await issueCode();
    const cookie = await redeem(code);
    for (let i = 0; i < 2; i++) {
      const ok = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ text: `msg ${i}`, clientMessageId: `r${i}` });
      expect(ok.status).toBe(201);
    }
    const limited = await request(app).post("/test-channel/messages").set("Cookie", cookie).send({ text: "msg 3", clientMessageId: "r3" });
    expect(limited.status).toBe(429);
  });

  it("returns 500 when persistence fails", async () => {
    const failingApp = express();
    failingApp.use(express.json());
    failingApp.use("/test-channel", createTestChannelRouter({ enabled: true, store, adminToken: ADMIN_TOKEN, persist: async () => { throw new Error("persist failed"); } }));
    failingApp.use(errorHandler);
    const session = store.createSession(shop.shopId, shop.phone, 60_000);
    const res = await request(failingApp).post("/test-channel/messages").set("Cookie", `bma_test_channel=${session.token}`).send({ text: "hi" });
    expect(res.status).toBe(500);
  });

  it("is disabled when created with enabled false", async () => {
    const disabledApp = express();
    disabledApp.use(express.json());
    disabledApp.use("/test-channel", createTestChannelRouter({ enabled: false }));
    disabledApp.use(errorHandler);
    const res = await request(disabledApp).get("/test-channel/");
    expect(res.status).toBe(404);
  });
});
