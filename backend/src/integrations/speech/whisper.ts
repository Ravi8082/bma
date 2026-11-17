import { env } from "../../config/env";
import type { SttProvider, SttTranscriptionInput, SttTranscriptionResult } from "./types";

export class WhisperSttProvider implements SttProvider {
  readonly name = "whisper";
  readonly model = "whisper-1";

  constructor(private readonly apiKey: string = env.STT_API_KEY ?? "") {}

  async transcribe(input: SttTranscriptionInput): Promise<SttTranscriptionResult> {
    if (!this.apiKey) throw new Error("STT_API_KEY is required for the whisper provider");

    const form = new FormData();
    const blob = new Blob([new Uint8Array(input.buffer)], { type: input.mimeType });
    form.append("file", blob, "audio.ogg");
    form.append("model", this.model);
    if (input.languageHint) form.append("language", input.languageHint);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`STT request failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { text?: string; language?: string; duration?: number };
    const result: SttTranscriptionResult = { text: (data.text ?? "").trim() };
    if (data.language) result.language = data.language;
    if (typeof data.duration === "number") result.durationSeconds = data.duration;
    return result;
  }
}
