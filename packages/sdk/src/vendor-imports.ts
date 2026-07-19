import { createHash } from "node:crypto";

import { DEFAULT_TRAICE_SERVER_URL, normalizeServerUrl } from "./ask";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export type ImportCredential = {
  apiKey: string;
  serverUrl?: string;
};

export type ImportRange = {
  since: Date;
  until?: Date;
};

export type VendorImportResult = {
  source: "litellm" | "langfuse";
  fetched: number;
  mapped: number;
  ignored: number;
  accepted: number;
  deduplicated: number;
  quotaDropped: number;
};

export type LiteLlmImportOptions = ImportRange & {
  baseUrl: string;
  apiKey: string;
  traice: ImportCredential;
  dryRun?: boolean;
  sourceKey?: string;
  fetchImpl?: FetchLike;
};

export type LangfuseImportOptions = ImportRange & {
  baseUrl?: string;
  publicKey: string;
  secretKey: string;
  traice: ImportCredential;
  dryRun?: boolean;
  sourceKey?: string;
  fetchImpl?: FetchLike;
};

export type ImportedEvent = {
  source: "litellm" | "langfuse";
  externalId: string;
  ts: string;
  provider: string;
  model: string;
  feature?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  workflowId?: string;
  runId?: string;
  stepId?: string;
  toolName?: string;
  retryCount?: number;
  outcome?: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  latencyMs?: number;
  status?: string;
  metadata: JsonObject;
};

export async function importLiteLlm(options: LiteLlmImportOptions): Promise<VendorImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const range = normalizedRange(options);
  const baseUrl = httpBaseUrl(options.baseUrl, "LiteLLM base URL");
  const result = emptyResult("litellm");

  for (const window of utcDateWindows(range.since, range.until, 7)) {
    const url = new URL("spend/logs", baseUrl);
    url.searchParams.set("start_date", dateOnly(window.start));
    url.searchParams.set("end_date", dateOnly(window.end));
    url.searchParams.set("summarize", "false");
    const payload = await fetchJson(url, {
      headers: { authorization: `Bearer ${requiredSecret(options.apiKey, "LiteLLM API key")}` },
      fetchImpl,
      label: "LiteLLM spend logs",
    });
    const rows = arrayPayload(payload, "data", "logs");
    const events = namespaceEvents(
      rows.flatMap((row) => {
        const event = mapLiteLlmSpendLog(row);
        return event && inRange(event.ts, range) ? [event] : [];
      }),
      options.sourceKey ?? baseUrl.toString(),
    );
    mergeResult(result, await uploadEvents("litellm", rows.length, events, options.traice, fetchImpl, options.dryRun));
  }
  return result;
}

export async function importLangfuse(options: LangfuseImportOptions): Promise<VendorImportResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const range = normalizedRange(options);
  const baseUrl = httpBaseUrl(options.baseUrl ?? "https://cloud.langfuse.com", "Langfuse base URL");
  const authorization = `Basic ${Buffer.from(
    `${requiredSecret(options.publicKey, "Langfuse public key")}:${requiredSecret(options.secretKey, "Langfuse secret key")}`,
  ).toString("base64")}`;
  const result = emptyResult("langfuse");

  for (const window of timeWindows(range.since, range.until, 7)) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const url = new URL("api/public/v2/observations", baseUrl);
      url.searchParams.set("fromStartTime", window.start.toISOString());
      url.searchParams.set("toStartTime", window.end.toISOString());
      url.searchParams.set("type", "GENERATION");
      url.searchParams.set("fields", "core,basic,metadata,model,usage,metrics,trace_context");
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);
      const payload = await fetchJson(url, {
        headers: { authorization },
        fetchImpl,
        label: "Langfuse observations",
      });
      const page = objectValue(payload);
      const rows = arrayValue(page.data);
      const events = namespaceEvents(
        rows.flatMap((row) => {
          const event = mapLangfuseObservation(row);
          return event && inRange(event.ts, range) ? [event] : [];
        }),
        options.sourceKey ?? baseUrl.toString(),
      );
      mergeResult(
        result,
        await uploadEvents("langfuse", rows.length, events, options.traice, fetchImpl, options.dryRun),
      );
      const nextCursor = optionalString(objectValue(page.meta).cursor);
      if (nextCursor && seenCursors.has(nextCursor)) throw new Error("Langfuse returned a repeated pagination cursor");
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
  }
  return result;
}

export function mapLiteLlmSpendLog(value: unknown): ImportedEvent | null {
  const row = objectValue(value);
  const metadata = objectValue(row.metadata);
  const spendMetadata = objectValue(metadata.spend_logs_metadata);
  const usage = objectValue(row.usage);
  const requestId = firstString(row.request_id, row.requestId);
  const timestamp = validTimestamp(firstValue(row.startTime, row.start_time, row.endTime, row.end_time));
  if (!requestId || !timestamp) return null;

  const rawModel = firstString(row.model, row.model_group, metadata.model) ?? "unknown";
  const provider = normalizeProvider(
    firstString(row.custom_llm_provider, row.provider, metadata.custom_llm_provider),
    rawModel,
  );
  const model = normalizeModel(rawModel, provider);
  const promptTokens = nonNegativeInt(firstValue(row.prompt_tokens, usage.prompt_tokens));
  const outputTokens = nonNegativeInt(firstValue(row.completion_tokens, usage.completion_tokens));
  const totalTokens = Math.max(
    promptTokens + outputTokens,
    nonNegativeInt(firstValue(row.total_tokens, usage.total_tokens), promptTokens + outputTokens),
  );
  const cacheReadTokens = nonNegativeInt(
    firstValue(
      row.cache_read_input_tokens,
      usage.cache_read_input_tokens,
      objectValue(usage.prompt_tokens_details).cached_tokens,
    ),
  );
  const cacheWriteTokens = nonNegativeInt(
    firstValue(row.cache_creation_input_tokens, usage.cache_creation_input_tokens),
  );
  const tags = stringArray(firstValue(row.request_tags, metadata.request_tags)).slice(0, 32);
  const status = firstString(row.status, row.request_status)?.toLowerCase();
  const failed = status === "error" || status === "failed" || status === "failure";

  return compactEvent({
    source: "litellm",
    externalId: requestId,
    ts: timestamp,
    provider,
    model,
    feature: firstString(spendMetadata.feature, metadata.feature, tagValue(tags, "feature")),
    userId: firstString(metadata.user_api_key_user_id, row.user),
    tenantId: firstString(row.end_user, spendMetadata.tenant_id, spendMetadata.tenantId),
    agentId: firstString(spendMetadata.agent_id, spendMetadata.agentId),
    workflowId: firstString(spendMetadata.workflow_id, spendMetadata.workflowId, spendMetadata.project_id),
    runId: firstString(spendMetadata.run_id, spendMetadata.runId, requestId),
    stepId: firstString(spendMetadata.step_id, spendMetadata.stepId),
    toolName: firstString(spendMetadata.tool_name, spendMetadata.toolName),
    retryCount: nonNegativeInt(firstValue(spendMetadata.retry_count, spendMetadata.retryCount)),
    outcome: firstString(spendMetadata.outcome) ?? (failed ? "error" : "success"),
    promptTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: nonNegativeNumber(firstValue(row.spend, row.response_cost)),
    latencyMs: durationMs(firstValue(row.startTime, row.start_time), firstValue(row.endTime, row.end_time)),
    status: failed ? "error" : "success",
    metadata: {
      integration: {
        source: "litellm",
        callType: firstString(row.call_type, row.callType),
        teamId: firstString(row.team_id, metadata.user_api_key_team_id),
        tags,
      },
    },
  });
}

export function mapLangfuseObservation(value: unknown): ImportedEvent | null {
  const row = objectValue(value);
  const metadata = objectValue(row.metadata);
  const usageDetails = objectValue(row.usageDetails);
  const costDetails = objectValue(row.costDetails);
  const id = optionalString(row.id);
  const timestamp = validTimestamp(row.startTime);
  if (!id || !timestamp) return null;

  const rawModel = firstString(row.providedModelName, row.modelId) ?? "unknown";
  const provider = normalizeProvider(firstString(metadata.provider, metadata.gen_ai_provider_name), rawModel);
  const model = normalizeModel(rawModel, provider);
  const promptTokens = nonNegativeInt(firstValue(row.inputUsage, usageDetails.input, usageDetails.prompt));
  const outputTokens = nonNegativeInt(firstValue(row.outputUsage, usageDetails.output, usageDetails.completion));
  const totalTokens = Math.max(
    promptTokens + outputTokens,
    nonNegativeInt(firstValue(row.totalUsage, usageDetails.total), promptTokens + outputTokens),
  );
  const level = optionalString(row.level)?.toUpperCase();
  const failed = level === "ERROR";
  const tags = stringArray(row.tags).slice(0, 32);

  return compactEvent({
    source: "langfuse",
    externalId: id,
    ts: timestamp,
    provider,
    model,
    feature: firstString(metadata["traice.feature"], metadata.traice_feature, metadata.feature, row.name),
    userId: firstString(metadata["traice.user_id"], metadata.traice_user_id, row.userId),
    tenantId: firstString(
      metadata["traice.tenant_id"],
      metadata.traice_tenant_id,
      metadata.tenantId,
      metadata.tenant_id,
    ),
    agentId: firstString(metadata["traice.agent_id"], metadata.traice_agent_id, metadata.agentId, metadata.agent_id),
    workflowId: firstString(metadata["traice.workflow_id"], metadata.traice_workflow_id, row.traceName, row.sessionId),
    runId: firstString(metadata["traice.run_id"], metadata.traice_run_id, row.traceId),
    stepId: firstString(metadata["traice.step_id"], metadata.traice_step_id, id),
    toolName: firstString(
      metadata["traice.tool_name"],
      metadata.traice_tool_name,
      metadata.toolName,
      metadata.tool_name,
    ),
    retryCount: nonNegativeInt(
      firstValue(metadata["traice.retry_count"], metadata.traice_retry_count, metadata.retryCount),
    ),
    outcome: firstString(metadata["traice.outcome"], metadata.traice_outcome) ?? (failed ? "error" : "success"),
    promptTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: nonNegativeInt(firstValue(usageDetails.cache_read, usageDetails.cacheRead)),
    cacheWriteTokens: nonNegativeInt(firstValue(usageDetails.cache_creation, usageDetails.cacheWrite)),
    costUsd: nonNegativeNumber(firstValue(row.totalCost, costDetails.total)),
    latencyMs: durationMs(row.startTime, row.endTime) ?? secondsToMs(row.latency),
    status: failed ? "error" : "success",
    metadata: {
      integration: {
        source: "langfuse",
        observationType: optionalString(row.type),
        projectId: optionalString(row.projectId),
        traceName: optionalString(row.traceName),
        environment: optionalString(row.environment),
        tags,
      },
    },
  });
}

async function uploadEvents(
  source: VendorImportResult["source"],
  fetched: number,
  events: ImportedEvent[],
  credential: ImportCredential,
  fetchImpl: FetchLike,
  dryRun = false,
): Promise<VendorImportResult> {
  const result: VendorImportResult = {
    source,
    fetched,
    mapped: events.length,
    ignored: fetched - events.length,
    accepted: 0,
    deduplicated: 0,
    quotaDropped: 0,
  };

  if (dryRun) return result;
  const apiKey = requiredSecret(credential.apiKey, "trAIce API key");
  const endpoint = `${normalizeServerUrl(credential.serverUrl ?? DEFAULT_TRAICE_SERVER_URL)}/api/v1/events`;

  for (let index = 0; index < events.length; index += 50) {
    const response = await fetchWithRetry(
      endpoint,
      {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ events: events.slice(index, index + 50) }),
      },
      fetchImpl,
      "trAIce import",
    );
    const body = await response.text();
    const payload = parseJson(body);
    if (!response.ok) {
      const error = firstString(objectValue(payload).message, objectValue(payload).error) ?? response.statusText;
      throw new Error(`trAIce import failed with HTTP ${response.status}: ${error}`);
    }
    const summary = objectValue(payload);
    result.accepted += nonNegativeInt(summary.accepted);
    result.deduplicated += nonNegativeInt(summary.deduplicated);
    result.quotaDropped += nonNegativeInt(summary.quotaDropped);
  }
  return result;
}

function emptyResult(source: VendorImportResult["source"]): VendorImportResult {
  return { source, fetched: 0, mapped: 0, ignored: 0, accepted: 0, deduplicated: 0, quotaDropped: 0 };
}

function mergeResult(target: VendorImportResult, page: VendorImportResult): void {
  target.fetched += page.fetched;
  target.mapped += page.mapped;
  target.ignored += page.ignored;
  target.accepted += page.accepted;
  target.deduplicated += page.deduplicated;
  target.quotaDropped += page.quotaDropped;
}

export function parseImportRange(value: string, untilValue?: string, now = new Date()): ImportRange {
  const until = untilValue ? validDate(untilValue) : new Date(now);
  if (!until) throw new Error("`until` must be a valid ISO date");
  const duration = value.trim().match(/^(\d+)(h|d|w)$/i);
  const since = duration
    ? new Date(until.getTime() - Number(duration[1]) * durationMsForUnit(duration[2].toLowerCase()))
    : validDate(value);
  if (!since) throw new Error("`since` must be an ISO date or a duration such as 24h, 7d, or 4w");
  return normalizedRange({ since, until });
}

function durationMsForUnit(unit: string): number {
  if (unit === "h") return 3_600_000;
  if (unit === "d") return 86_400_000;
  return 7 * 86_400_000;
}

function normalizedRange(range: ImportRange): { since: Date; until: Date } {
  const since = new Date(range.since);
  const until = range.until ? new Date(range.until) : new Date();
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
    throw new Error("Import range must use valid dates");
  if (since >= until) throw new Error("Import `since` must be earlier than `until`");
  return { since, until };
}

function timeWindows(since: Date, until: Date, days: number): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let start = since;
  while (start < until) {
    const end = new Date(Math.min(until.getTime(), start.getTime() + days * 86_400_000));
    windows.push({ start, end });
    start = end;
  }
  return windows;
}

function utcDateWindows(since: Date, until: Date, days: number): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let start = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const lastDay = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  while (start <= lastDay) {
    const end = new Date(Math.min(lastDay.getTime(), start.getTime() + (days - 1) * 86_400_000));
    windows.push({ start, end });
    start = new Date(end.getTime() + 86_400_000);
  }
  return windows;
}

async function fetchJson(
  url: URL,
  options: { headers: Record<string, string>; fetchImpl: FetchLike; label: string },
): Promise<unknown> {
  const response = await fetchWithRetry(url, { headers: options.headers }, options.fetchImpl, options.label);
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.label} failed with HTTP ${response.status}`);
  const parsed = parseJson(body);
  if (parsed == null) throw new Error(`${options.label} returned invalid JSON`);
  return parsed;
}

async function fetchWithRetry(
  input: string | URL,
  init: RequestInit,
  fetchImpl: FetchLike,
  label: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(30_000) });
      if (!isRetryableStatus(response.status) || attempt === 4) return response;
      await response.body?.cancel().catch(() => undefined);
      await delay(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (attempt === 4) break;
      await delay(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
  throw new Error(
    `${label} failed after retries: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
    const date = new Date(retryAfter).getTime();
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetSeconds)) return Math.min(60_000, Math.max(0, resetSeconds * 1000));
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactEvent(event: ImportedEvent): ImportedEvent {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as ImportedEvent;
}

function httpBaseUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith("/") ? value : `${value}/`);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${label} must use HTTP or HTTPS`);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

function requiredSecret(value: string, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function inRange(timestamp: string, range: { since: Date; until: Date }): boolean {
  const value = new Date(timestamp).getTime();
  return value >= range.since.getTime() && value < range.until.getTime();
}

function namespaceEvents(events: ImportedEvent[], sourceKey: string): ImportedEvent[] {
  const namespace = createHash("sha256").update(sourceKey).digest("hex").slice(0, 16);
  return events.map((event) => {
    const externalId = `${namespace}:${event.externalId}`;
    return {
      ...event,
      externalId:
        externalId.length <= 256
          ? externalId
          : `${namespace}:${createHash("sha256").update(event.externalId).digest("hex").slice(0, 40)}`,
    };
  });
}

function normalizeProvider(value: string | null | undefined, model: string): string {
  const raw = (value ?? model.split("/", 1)[0] ?? "unknown").toLowerCase();
  if (raw === "azure" || raw === "azure_ai" || raw === "azure_openai") return "openai";
  if (raw === "vertex_ai" || raw === "google" || raw === "gemini") return "google-vertex";
  if (raw === "bedrock" || raw === "aws_bedrock") return "aws-bedrock";
  return raw || "unknown";
}

function normalizeModel(model: string, provider: string): string {
  const [prefix, ...rest] = model.split("/");
  const normalizedPrefix = normalizeProvider(prefix, prefix);
  return rest.length > 0 && normalizedPrefix === provider ? rest.join("/") : model;
}

function durationMs(start: unknown, end: unknown): number | undefined {
  const startDate = validDate(start);
  const endDate = validDate(end);
  if (!startDate || !endDate || endDate < startDate) return undefined;
  return endDate.getTime() - startDate.getTime();
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = numberValue(value);
  return seconds == null || seconds < 0 ? undefined : Math.round(seconds * 1000);
}

function validTimestamp(value: unknown): string | null {
  return validDate(value)?.toISOString() ?? null;
}

function validDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function tagValue(tags: string[], key: string): string | undefined {
  const prefix = `${key}:`;
  return tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length) || undefined;
}

function arrayPayload(value: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const object = objectValue(value);
  for (const key of keys) {
    if (Array.isArray(object[key])) return object[key];
  }
  return [];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const string = optionalString(item);
    return string ? [string.slice(0, 256)] : [];
  });
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = optionalString(value);
    if (string) return string;
  }
  return undefined;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value != null && value !== "");
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  return Math.floor(nonNegativeNumber(value, fallback));
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  const number = numberValue(value);
  return number == null ? fallback : Math.max(0, number);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
