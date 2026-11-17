import type { SttProvider, SttTranscriptionInput, SttTranscriptionResult } from "./types";

export class StubSttProvider implements SttProvider {
  readonly name = "stub";
  readonly model = "stub-stt";

  constructor(
    private readonly transcript: string = "Ramesh 300 udhaar",
    private readonly language: string = "hi",
  ) {}

  async transcribe(_input: SttTranscriptionInput): Promise<SttTranscriptionResult> {
    return { text: this.transcript, language: this.language, durationSeconds: 3 };
  }
}
