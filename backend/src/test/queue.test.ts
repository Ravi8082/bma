import { describe, expect, it } from "vitest";
import { InlineQueue } from "../jobs/queue";

describe("InlineQueue", () => {
  it("runs a job and records it as processed", async () => {
    const queue = new InlineQueue();
    let received = "";
    queue.register<{ text: string }>("inbound.message", async (payload) => {
      received = payload.text;
    });

    const jobId = await queue.enqueue("inbound.message", { text: "Rahul ko 500 diya" });

    expect(received).toBe("Rahul ko 500 diya");
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queue.stats()).toMatchObject({ processed: 1, deadLetters: 0 });
  });

  it("retries a failing job and succeeds within the attempt budget", async () => {
    const queue = new InlineQueue();
    let attempts = 0;
    queue.register("extraction.run", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("provider timeout");
    });

    await queue.enqueue("extraction.run", {}, { attempts: 3 });

    expect(attempts).toBe(3);
    expect(queue.stats()).toMatchObject({ processed: 1, deadLetters: 0 });
  });

  it("moves an exhausted job to the dead-letter queue", async () => {
    const queue = new InlineQueue();
    queue.register("outbox.send", async () => {
      throw new Error("permanent failure");
    });

    await queue.enqueue("outbox.send", { messageId: "x" }, { attempts: 2 });

    expect(queue.stats()).toMatchObject({ processed: 0, deadLetters: 1 });
    expect(queue.listDeadLetters()[0]).toMatchObject({
      name: "outbox.send",
      attempts: 2,
      error: "permanent failure",
    });
  });

  it("runs an idempotent job once per idempotency key", async () => {
    const queue = new InlineQueue();
    let runs = 0;
    queue.register("inbound.message", async () => {
      runs += 1;
    });

    await queue.enqueue("inbound.message", {}, { idempotencyKey: "wa:ABC123" });
    await queue.enqueue("inbound.message", {}, { idempotencyKey: "wa:ABC123" });
    await queue.enqueue("inbound.message", {}, { idempotencyKey: "wa:XYZ789" });

    expect(runs).toBe(2);
  });

  it("refuses a job with no registered handler", async () => {
    const queue = new InlineQueue();
    await expect(queue.enqueue("missing.job", {})).rejects.toThrow(/no handler registered/);
  });
});
