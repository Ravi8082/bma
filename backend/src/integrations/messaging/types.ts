/**
 * Provider contract for WhatsApp-style messaging.
 *
 * Meta Cloud API and the local simulator both implement this. Nothing above
 * this interface knows which one is active, so switching providers is an env
 * change, not a refactor.
 */

export interface SendResult {
  providerMessageId: string;
  acceptedAt: Date;
}

export interface SendTextInput {
  to: string;
  text: string;
  /** Rendered as a quoted reply where the provider supports it. */
  replyToMessageId?: string;
  /** WhatsApp marks inbound messages read when the bot replies. */
  markInboundRead?: boolean;
}

export interface ButtonOption {
  id: string;
  title: string;
}

export interface SendButtonsInput {
  to: string;
  body: string;
  buttons: ButtonOption[];
  header?: string;
  footer?: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export interface SendListInput {
  to: string;
  body: string;
  buttonText: string;
  sections: ListSection[];
  header?: string;
  footer?: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language: string;
  /** Positional body variables in template order. */
  bodyParameters?: string[];
  headerParameters?: string[];
}

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
  fileName?: string;
}

export interface MessagingProvider {
  readonly name: string;
  sendText(input: SendTextInput): Promise<SendResult>;
  sendButtons(input: SendButtonsInput): Promise<SendResult>;
  sendList(input: SendListInput): Promise<SendResult>;
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  markRead(providerMessageId: string): Promise<void>;
  downloadMedia(providerMediaId: string): Promise<DownloadedMedia>;
}
