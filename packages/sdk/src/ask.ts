export const DEFAULT_TRAICE_SERVER_URL = "https://www.runtraice.com";

export type AskTraiceResponse = {
  question: string;
  interpretedQuery: string;
  router: "llm" | "fallback";
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  results: Array<Record<string, unknown>>;
  answer: string;
};

export type AskActionInput =
  | {
      action: "create_budget";
      name: string;
      limitUsd: number;
      scope?: "WORKSPACE" | "FEATURE" | "USER" | "TENANT";
      scopeValue?: string;
      period?: "DAILY" | "WEEKLY" | "MONTHLY";
    }
  | { action: "snooze_alert"; alertId: string; hours?: number; reason?: string }
  | { action: "create_shadow_guardrail"; experimentId: string };

export type PrepareAskActionResponse = {
  status: "confirmation_required";
  confirmationId: string;
  action: AskActionInput["action"];
  summary: string;
  confirmationToken: string;
  confirmationPhrase: string;
  expiresAt: string;
  workspacePlan: string;
  instruction: string;
};

export type ConfirmAskActionResponse = {
  status: "confirmed" | "already_confirmed";
  confirmationId: string;
  result: Record<string, unknown>;
};

export type AskClientOptions = { apiKey: string; serverUrl?: string; signal?: AbortSignal };

export async function askTraice(question: string, options: AskClientOptions): Promise<AskTraiceResponse> {
  const payload = await postAskJson<AskTraiceResponse>("/api/v1/ask", { question }, options, "ask");
  if (!payload?.answer) throw new Error("trAIce ask returned an invalid response");
  return payload;
}

export async function prepareAskAction(
  action: AskActionInput,
  options: AskClientOptions,
): Promise<PrepareAskActionResponse> {
  return postAskJson<PrepareAskActionResponse>("/api/v1/ask/actions/prepare", action, options, "action");
}

export async function confirmAskAction(
  confirmationToken: string,
  confirmationPhrase: string,
  options: AskClientOptions,
): Promise<ConfirmAskActionResponse> {
  return postAskJson<ConfirmAskActionResponse>(
    "/api/v1/ask/actions/confirm",
    { confirmationToken, confirmationPhrase },
    options,
    "action",
  );
}

async function postAskJson<T>(
  path: string,
  body: unknown,
  options: AskClientOptions,
  operation: "ask" | "action",
): Promise<T> {
  const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_TRAICE_SERVER_URL);
  const response = await fetch(`${serverUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "X-Source": "traice-cli",
    },
    body: JSON.stringify(body),
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });

  const payload = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    const reason = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
    throw new Error(`trAIce ${operation} failed: ${reason}`);
  }
  if (!payload) throw new Error(`trAIce ${operation} returned an invalid response`);
  return payload;
}

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("trAIce server URL must use HTTPS");
  }
  return parsed.toString().replace(/\/+$/, "");
}
