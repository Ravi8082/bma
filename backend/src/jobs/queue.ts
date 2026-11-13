import { randomUUID } from "node:crypto";
import { logger } from "../config/logger";

export type JobHandler<TPayload = unknown> = (payload: TPayload, meta: JobMeta) => Promise<void>;

export interface JobMeta {
  jobId: string;
  name: string;
  attempt: number;
  idempotencyKey?: string;
}

export interface EnqueueOptions {
  /** Used for de-duplication. Two enqueues with the same key within the TTL run once. */
  idempotencyKey?: string;
  /** Total attempts including the first. Defaults to 3. */
  attempts?: number;
}

export interface DeadLetter {
  name: string;
  payload: unknown;
  attempts: number;
  error: string;
  failedAt: Date;
}

export interface QueueDriver {
  readonly driver: "inline" | "bullmq";
  register<TPayload>(name: string, handler: JobHandler<TPayload>): void;
  enqueue<TPayload>(name: string, payload: TPayload, options?: EnqueueOptions): Promise<string>;
  ping(): Promise<boolean>;
  stats(): { processed: number; deadLetters: number; pending: number };
  drain(): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-process queue for local demos and tests.
 *
 * It deliberately implements the same contract as the BullMQ driver (retries,
 * idempotency keys, dead letters) so handlers are written once. It is NOT
 * durable and does not survive a restart; `env` refuses it in production.
 */
export class InlineQueue implements QueueDriver {
  readonly driver = "inline" as const;

  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly seenKeys = new Set<string>();
  private readonly deadLetterQueue: DeadLetter[] = [];
  private processed = 0;

  register<TPayload>(name: string, handler: JobHandler<TPayload>): void {
    if (this.handlers.has(name)) {
      throw new Error(`job handler already registered for "${name}"`);
    }
    this.handlers.set(name, handler as JobHandler<never>);
  }

  async enqueue<TPayload>(
    name: string,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<string> {
    const handler = this.handlers.get(name) as JobHandler<TPayload> | undefined;
    if (!handler) {
      throw new Error(`no handler registered for job "${name}"`);
    }

    const key = options.idempotencyKey;
    if (key) {
      if (this.seenKeys.has(key)) {
        logger.debug({ name, key }, "inline queue: duplicate job skipped");
        return `deduped:${key}`;
      }
      this.seenKeys.add(key);
    }

    const jobId = randomUUID();
    const attempts = options.attempts ?? 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await handler(payload, {
          jobId,
          name,
          attempt,
          ...(key === undefined ? {} : { idempotencyKey: key }),
        });
        this.processed += 1;
        return jobId;
      } catch (error) {
        const isLast = attempt === attempts;
        logger.warn({ err: error, name, attempt, isLast }, "inline queue: job attempt failed");
        if (isLast) {
          this.deadLetterQueue.push({
            name,
            payload,
            attempts,
            error: error instanceof Error ? error.message : String(error),
            failedAt: new Date(),
          });
        }
      }
    }

    return jobId;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  stats(): { processed: number; deadLetters: number; pending: number } {
    return {
      processed: this.processed,
      deadLetters: this.deadLetterQueue.length,
      pending: 0,
    };
  }

  listDeadLetters(): readonly DeadLetter[] {
    return this.deadLetterQueue;
  }

  async drain(): Promise<void> {
    // Jobs run inline, so there is nothing queued to drain.
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.seenKeys.clear();
  }

  reset(): void {
    this.deadLetterQueue.length = 0;
    this.seenKeys.clear();
    this.processed = 0;
  }
}
