export const DEFAULT_TRAICE_SERVER_URL = "https://www.runtraice.com";

export type AskTraiceResponse = {
  question: string;
  interpretedQuery: string;
  router: "llm" | "fallback";
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  results: Array<Record<string, unknown>>;
  answer: string;
};

export async function askTraice(
  question: string,
  options: { apiKey: string; serverUrl?: string; signal?: AbortSignal },
): Promise<AskTraiceResponse> {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_TRAICE_SERVER_URL);
  const response = await fetch(`${serverUrl}/api/v1/ask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "X-Source": "traice-cli",
    },
    body: JSON.stringify({ question }),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });

  const payload = (await response.json().catch(() => null)) as
    (AskTraiceResponse & { error?: string; message?: string }) | null;
  if (!response.ok) {
    const reason = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
    throw new Error(`trAIce ask failed: ${reason}`);
  }
  if (!payload?.answer) throw new Error("trAIce ask returned an invalid response");
  return payload;
}

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("trAIce server URL must use HTTPS");
  }
  return parsed.toString().replace(/\/+$/, "");
}
