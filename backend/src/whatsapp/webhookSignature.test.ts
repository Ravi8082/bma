import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "./webhookSignature";

describe("webhook signature verification", () => {
  const secret = "test-app-secret-32-bytes-minimum!!";
  const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [] } }] }] }));

  function sign(payload: Buffer): string {
    return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  }

  function makeReq(headers: Record<string, string>, rawBody?: Buffer) {
    return { headers, rawBody } as unknown as Parameters<ReturnType<typeof verifyWebhookSignature>>[0];
  }

  function makeRes() {
    const res = { statusCode: 0, body: null as unknown };
    return {
      status(code: number) { res.statusCode = code; return this; },
      json(payload: unknown) { res.body = payload; return this; },
      get statusCode() { return res.statusCode; },
    };
  }

  it("accepts a valid signature", () => {
    const req = makeReq({ "x-hub-signature-256": sign(body) }, body);
    const res = makeRes();
    let nextCalled = false;
    verifyWebhookSignature(secret)(req, res as never, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it("rejects a missing signature", () => {
    const req = makeReq({}, body);
    const res = makeRes();
    verifyWebhookSignature(secret)(req, res as never, () => {});
    expect(res.statusCode).toBe(401);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ text: "evil" }] } }] }] }));
    const req = makeReq({ "x-hub-signature-256": sign(body) }, tampered);
    const res = makeRes();
    verifyWebhookSignature(secret)(req, res as never, () => {});
    expect(res.statusCode).toBe(401);
  });

  it("rejects a signature with wrong length", () => {
    const req = makeReq({ "x-hub-signature-256": "sha256=abcd" }, body);
    const res = makeRes();
    verifyWebhookSignature(secret)(req, res as never, () => {});
    expect(res.statusCode).toBe(401);
  });
});
