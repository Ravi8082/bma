import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { simulatorStore } from "../container";

const PHONE = "+919876543210";

beforeEach(() => {
  simulatorStore.reset();
});

describe("simulator provider", () => {
  it("records an outbound text message instead of calling Meta", async () => {
    const app = createApp();

    const send = await request(app)
      .post("/simulator/send")
      .send({ to: PHONE, text: "Sharma Tiffin: aaj ka hisaab ₹1,50,000.00" });

    expect(send.status).toBe(201);
    expect(send.body.data.providerMessageId).toMatch(/^sim_/);

    const outbox = await request(app).get(`/simulator/outbox?to=${encodeURIComponent(PHONE)}`);
    expect(outbox.status).toBe(200);
    expect(outbox.body.data).toHaveLength(1);
    expect(outbox.body.data[0]).toMatchObject({
      to: PHONE,
      kind: "TEXT",
      status: "ACCEPTED",
    });
    expect(outbox.body.data[0].body).toContain("Sharma Tiffin");
  });

  it("validates the recipient before recording anything", async () => {
    const app = createApp();
    const response = await request(app)
      .post("/simulator/send")
      .send({ to: "9876543210", text: "no plus prefix" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(simulatorStore.size).toBe(0);
  });

  it("serves the inbox and resets state", async () => {
    const app = createApp();
    await request(app).post("/simulator/send").send({ to: PHONE, text: "hello" });

    const inbox = await request(app).get("/simulator");
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain("WhatsApp simulator inbox");
    expect(inbox.text).toContain("hello");

    const reset = await request(app).post("/simulator/reset");
    expect(reset.status).toBe(200);
    expect(simulatorStore.size).toBe(0);
  });

  it("escapes message content in the HTML inbox", async () => {
    const app = createApp();
    await request(app)
      .post("/simulator/send")
      .send({ to: PHONE, text: "<script>alert(1)</script>" });

    const inbox = await request(app).get("/simulator");
    expect(inbox.text).not.toContain("<script>alert(1)</script>");
    expect(inbox.text).toContain("&lt;script&gt;");
  });
});
