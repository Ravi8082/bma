/**
 * Meta Cloud API messaging provider.
 *
 * Talks to the WhatsApp Cloud API over HTTPS using the configured access token.
 * The base URL is configurable so tests can point it at a local HTTP server; in
 * production it is pinned to graph.facebook.com by the environment validation.
 */
import type {
  DownloadedMedia,
  MessagingProvider,
  SendButtonsInput,
  SendListInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
} from "./types";

export class MetaApiError extends Error {
  readonly code = "META_API_ERROR";
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Meta API request failed with HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "MetaApiError";
    this.status = status;
  }
}

export interface MetaProviderConfig {
  accessToken: string;
  phoneNumberId: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class MetaCloudMessagingProvider implements MessagingProvider {
  readonly name = "meta";

  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MetaProviderConfig) {
    this.accessToken = config.accessToken;
    this.phoneNumberId = config.phoneNumberId;
    this.baseUrl = (config.baseUrl ?? "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new MetaApiError(response.status, text);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MetaApiError(response.status, "invalid JSON response");
    }
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new MetaApiError(response.status, text);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MetaApiError(response.status, "invalid JSON response");
    }
  }

  private resultFrom(json: Record<string, unknown>): SendResult {
    const messages = json.messages as Array<{ id?: string }> | undefined;
    const providerMessageId = messages?.[0]?.id;
    if (!providerMessageId) {
      throw new MetaApiError(200, "response did not contain a message id");
    }
    return { providerMessageId, acceptedAt: new Date() };
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const json = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { body: input.text },
    });
    return this.resultFrom(json);
  }

  async sendButtons(input: SendButtonsInput): Promise<SendResult> {
    const json = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.body },
        ...(input.header ? { header: { type: "text", text: input.header } } : {}),
        ...(input.footer ? { footer: { text: input.footer } } : {}),
        action: {
          buttons: input.buttons.map((button) => ({
            type: "reply",
            reply: { id: button.id, title: button.title.slice(0, 20) },
          })),
        },
      },
    });
    return this.resultFrom(json);
  }

  async sendList(input: SendListInput): Promise<SendResult> {
    const json = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive: {
        type: "list",
        ...(input.header ? { header: { type: "text", text: input.header } } : {}),
        body: { text: input.body },
        ...(input.footer ? { footer: { text: input.footer } } : {}),
        action: {
          button: input.buttonText.slice(0, 20),
          sections: input.sections.map((section) => ({
            title: section.title,
            rows: section.rows.map((row) => ({
              id: row.id,
              title: row.title,
              ...(row.description ? { description: row.description } : {}),
            })),
          })),
        },
      },
    });
    return this.resultFrom(json);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const components =
      input.bodyParameters && input.bodyParameters.length > 0
        ? [{ type: "body", parameters: input.bodyParameters.map((text) => ({ type: "text", text })) }]
        : undefined;
    const json = await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: input.to,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.language },
        ...(components ? { components } : {}),
      },
    });
    return this.resultFrom(json);
  }

  async markRead(providerMessageId: string): Promise<void> {
    await this.post(`${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: providerMessageId,
    });
  }

  async downloadMedia(providerMediaId: string): Promise<DownloadedMedia> {
    const meta = await this.get(providerMediaId);
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!url) throw new MetaApiError(200, "media metadata did not contain a url");
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      redirect: "error",
    });
    if (!response.ok) {
      throw new MetaApiError(response.status, await response.text().catch(() => ""));
    }
    const mimeType =
      (typeof meta.mime_type === "string" ? meta.mime_type : "") ||
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    const data = Buffer.from(await response.arrayBuffer());
    const result: DownloadedMedia = { data, mimeType };
    if (typeof meta.file_name === "string") result.fileName = meta.file_name;
    return result;
  }
}
