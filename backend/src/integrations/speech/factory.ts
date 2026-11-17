import { env } from "../../config/env";
import { StubSttProvider } from "./stub";
import { WhisperSttProvider } from "./whisper";
import type { SttProvider } from "./types";

export function createSttProvider(provider: string, apiKey?: string): SttProvider {
  if (provider === "whisper") return new WhisperSttProvider(apiKey ?? env.STT_API_KEY);
  return new StubSttProvider();
}
