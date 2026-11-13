import { randomUUID } from "node:crypto";
import type { DownloadedMedia, ListRow } from "../integrations/messaging/types";

export type SimulatedMessageKind = "TEXT" | "BUTTONS" | "LIST" | "TEMPLATE";

export interface SimulatedMessage {
  id: string;
  to: string;
  kind: SimulatedMessageKind;
  body: string;
  templateName?: string;
  buttons?: { id: string; title: string }[];
  rows?: ListRow[];
  sentAt: Date;
  status: "ACCEPTED" | "READ";
  readAt?: Date;
}

export class MediaNotFoundError extends Error {
  readonly code = "SIMULATOR_MEDIA_NOT_FOUND";

  constructor(mediaId: string) {
    super(`Simulator has no media registered under "${mediaId}"`);
    this.name = "MediaNotFoundError";
  }
}

/**
 * In-memory record of everything the platform would have sent. Backs the
 * simulator inbox and lets tests assert on outbound messages without mocking
 * our own services.
 */
export class SimulatorStore {
  private messages: SimulatedMessage[] = [];
  private readonly media = new Map<string, DownloadedMedia>();

  add(message: Omit<SimulatedMessage, "id" | "sentAt" | "status">): SimulatedMessage {
    const stored: SimulatedMessage = {
      ...message,
      id: `sim_${randomUUID()}`,
      sentAt: new Date(),
      status: "ACCEPTED",
    };
    this.messages.push(stored);
    return stored;
  }

  list(filter: { to?: string; limit?: number } = {}): SimulatedMessage[] {
    const matching = filter.to
      ? this.messages.filter((message) => message.to === filter.to)
      : this.messages;
    const limit = filter.limit ?? 100;
    return matching.slice(-limit).map((message) => ({ ...message }));
  }

  get(id: string): SimulatedMessage | undefined {
    return this.messages.find((message) => message.id === id);
  }

  markRead(id: string): void {
    const message = this.messages.find((candidate) => candidate.id === id);
    if (message) {
      message.status = "READ";
      message.readAt = new Date();
    }
  }

  registerMedia(mediaId: string, media: DownloadedMedia): void {
    this.media.set(mediaId, media);
  }

  getMedia(mediaId: string): DownloadedMedia {
    const media = this.media.get(mediaId);
    if (!media) throw new MediaNotFoundError(mediaId);
    return media;
  }

  reset(): void {
    this.messages = [];
    this.media.clear();
  }

  get size(): number {
    return this.messages.length;
  }
}
