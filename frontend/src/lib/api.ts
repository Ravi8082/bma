export interface HealthResponse {
  ok: boolean;
  data: {
    status: string;
    service: string;
    env: string;
    uptimeSeconds: number;
    now: string;
  };
}

export interface OutboxMessage {
  id: string;
  to: string;
  kind: string;
  body: string;
  sentAt: string;
  status: string;
}

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const api = {
  health: (signal?: AbortSignal) => getJson<HealthResponse>("/health", signal),
  outbox: (signal?: AbortSignal) =>
    getJson<{ ok: boolean; data: OutboxMessage[] }>("/simulator/outbox", signal),
};
