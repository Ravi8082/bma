import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("health", () => {
  it("reports liveness", async () => {
    const app = createApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.status).toBe("ok");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is ready only when every dependency answers", async () => {
    const ready = createApp({
      health: { pingDatabase: async () => true, pingQueue: async () => true },
    });
    const happy = await request(ready).get("/health/ready");
    expect(happy.status).toBe(200);
    expect(happy.body.data).toMatchObject({
      ready: true,
      components: { database: true, queue: true },
    });

    const degraded = createApp({
      health: { pingDatabase: async () => true, pingQueue: async () => false },
    });
    const sad = await request(degraded).get("/health/ready");
    expect(sad.status).toBe(503);
    expect(sad.body.ok).toBe(false);
    expect(sad.body.data.components.database).toBe(true);
    expect(sad.body.data.components.queue).toBe(false);
  });

  it("treats a thrown dependency check as not ready", async () => {
    const app = createApp({
      health: {
        pingDatabase: async () => {
          throw new Error("mongo down");
        },
        pingQueue: async () => true,
      },
    });
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(503);
    expect(response.body.data.components.database).toBe(false);
  });

  it("returns the error envelope for unknown routes", async () => {
    const app = createApp();
    const response = await request(app).get("/api/v1/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(typeof response.body.error.requestId).toBe("string");
  });

  it("echoes a safe caller request id", async () => {
    const app = createApp();
    const response = await request(app).get("/health").set("x-request-id", "req-abc-12345678");
    expect(response.headers["x-request-id"]).toBe("req-abc-12345678");
  });
});
