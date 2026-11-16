/**
 * Contract test: the same suite runs against the simulator provider and the Meta
 * provider, with the Meta Graph API mocked at the HTTP layer.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMessagingProvider } from "../integrations/messaging/factory";
import { SimulatorMessagingProvider } from "../integrations/messaging/simulator";
import { MetaCloudMessagingProvider } from "../integrations/messaging/meta";
import { MetaApiError } from "../integrations/messaging/meta";
import { SimulatorStore } from "../simulator/store";
import type { MessagingProvider } from "../integrations/messaging/types";

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let mockServer: ReturnType<typeof createServer>;
let mockBaseUrl = "";
const captured: CapturedRequest[] = [];
let nextId = 1;

function resetCaptured(): void {
  captured.length = 0;
  nextId = 1;
}

beforeAll(async () => {
  mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      captured.push({
        method: req.method ?? "GET",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body,
      });

      // markRead / media metadata endpoints return an empty-ish success.
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ url: "https://lookaside.fbsbx.com/test", mime_type: "image/png" }));
        return;
      }

      // Failures are triggered by a sentinel recipient.
      const parsedBody = body as { to?: string } | null;
      if (parsedBody?.to === "fail@example.com") {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ messages: [{ id: `wamid.mock.${nextId++}` }] }));
    });
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = mockServer.address();
  if (typeof address === "object" && address) {
    mockBaseUrl = `http://127.0.0.1:${address.port}`;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    mockServer.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  resetCaptured();
});

function makeProvider(kind: "simulator" | "meta"): MessagingProvider {
  if (kind === "simulator") {
    return new SimulatorMessagingProvider(new SimulatorStore());
  }
  return new MetaCloudMessagingProvider({
    accessToken: "test-token",
    phoneNumberId: "12345",
    baseUrl: mockBaseUrl,
    fetchImpl: fetch,
  });
}

const PROVIDERS: Array<"simulator" | "meta"> = ["simulator", "meta"];

describe.each(PROVIDERS)("%s provider contract", (kind) => {
  it("sendText returns a non-empty providerMessageId", async () => {
    const provider = makeProvider(kind);
    const result = await provider.sendText({ to: "+919876543210", text: "Hello contract" });
    expect(typeof result.providerMessageId).toBe("string");
    expect(result.providerMessageId.length).toBeGreaterThan(0);
    expect(result.acceptedAt).toBeInstanceOf(Date);
  });

  it("sendButtons returns a non-empty providerMessageId", async () => {
    const provider = makeProvider(kind);
    const result = await provider.sendButtons({
      to: "+919876543210",
      body: "Pick one",
      buttons: [
        { id: "confirm:1", title: "Confirm" },
        { id: "cancel:1", title: "Cancel" },
      ],
    });
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it("sendList returns a non-empty providerMessageId", async () => {
    const provider = makeProvider(kind);
    const result = await provider.sendList({
      to: "+919876543210",
      body: "Choose",
      buttonText: "Open",
      sections: [{ title: "Items", rows: [{ id: "r1", title: "Row one" }] }],
    });
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });

  it("sendTemplate returns a non-empty providerMessageId", async () => {
    const provider = makeProvider(kind);
    const result = await provider.sendTemplate({
      to: "+919876543210",
      templateName: "hello_world",
      language: "en_US",
      bodyParameters: ["Ramesh"],
    });
    expect(result.providerMessageId.length).toBeGreaterThan(0);
  });
});

describe("meta provider: HTTP contract", () => {
  it("posts to the Graph API with bearer auth and the phone number id", async () => {
    const provider = makeProvider("meta");
    await provider.sendText({ to: "+919876543210", text: "Hi" });
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/12345/messages");
    expect(req.authorization).toBe("Bearer test-token");
    const body = req.body as { messaging_product: string; to: string; type: string; text: { body: string } };
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe("+919876543210");
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("Hi");
  });

  it("throws MetaApiError on a non-2xx response", async () => {
    const provider = makeProvider("meta");
    await expect(
      provider.sendText({ to: "fail@example.com", text: "Hi" }),
    ).rejects.toBeInstanceOf(MetaApiError);
  });

  it("markRead posts a read receipt", async () => {
    const provider = makeProvider("meta");
    await provider.markRead("wamid.mock.1");
    const req = captured[captured.length - 1]!;
    const body = req.body as { status: string; message_id: string };
    expect(body.status).toBe("read");
    expect(body.message_id).toBe("wamid.mock.1");
  });

  it("createMessagingProvider('meta') requires configuration", () => {
    expect(() => createMessagingProvider("meta", { simulatorStore: new SimulatorStore() })).toThrow();
  });
});
