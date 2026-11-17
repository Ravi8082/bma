export interface SttTranscriptionInput {
  buffer: Buffer;
  mimeType: string;
  languageHint?: string;
}

export interface SttTranscriptionResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

export interface SttProvider {
  readonly name: string;
  readonly model: string;
  transcribe(input: SttTranscriptionInput): Promise<SttTranscriptionResult>;
}
