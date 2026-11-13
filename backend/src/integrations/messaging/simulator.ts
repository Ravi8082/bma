import type {
  DownloadedMedia,
  MessagingProvider,
  SendButtonsInput,
  SendListInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
} from "./types";
import type { SimulatorStore } from "../../simulator/store";

/**
 * Local provider: records outbound messages instead of calling Meta.
 *
 * The rest of the system (webhook handler, workers, state machine) runs
 * unchanged, which is what makes simulator results trustworthy.
 */
export class SimulatorMessagingProvider implements MessagingProvider {
  readonly name = "simulator";

  constructor(private readonly store: SimulatorStore) {}

  private accept(kind: "TEXT" | "BUTTONS" | "LIST" | "TEMPLATE", body: string, input: { to: string }): SendResult {
    const stored = this.store.add({ to: input.to, kind, body });
    return { providerMessageId: stored.id, acceptedAt: stored.sentAt };
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    return this.accept("TEXT", input.text, input);
  }

  async sendButtons(input: SendButtonsInput): Promise<SendResult> {
    const lines = [input.body, ...input.buttons.map((button) => `[${button.title}]`)];
    return this.accept("BUTTONS", lines.join("\n"), input);
  }

  async sendList(input: SendListInput): Promise<SendResult> {
    const lines = [input.body];
    for (const section of input.sections) {
      lines.push(section.title);
      for (const row of section.rows) {
        lines.push(`- ${row.title}${row.description ? `: ${row.description}` : ""}`);
      }
    }
    return this.accept("LIST", lines.join("\n"), input);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const params = input.bodyParameters?.join(" | ") ?? "";
    const body = `[template:${input.templateName}/${input.language}]${params ? ` ${params}` : ""}`;
    const result = this.accept("TEMPLATE", body, input);
    const stored = this.store.get(result.providerMessageId);
    if (stored) stored.templateName = input.templateName;
    return result;
  }

  async markRead(providerMessageId: string): Promise<void> {
    this.store.markRead(providerMessageId);
  }

  async downloadMedia(providerMediaId: string): Promise<DownloadedMedia> {
    return this.store.getMedia(providerMediaId);
  }
}
