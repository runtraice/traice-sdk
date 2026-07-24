import { createHash } from "node:crypto";
import type { CollectorIdentity, CollectorSource, InternalUsageEvent, JsonRecord, JsonValue } from "@traice/protocol";
import { normalizeInternalUsageEvent, redactMetadata, stableSourceEventId } from "@traice/protocol";

export interface NormalizedOtelRecord {
  name?: string;
  body?: unknown;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  observedAt?: string;
  occurredAt?: string;
  severity?: string;
}

export interface NormalizedOtelMetricPoint {
  metricName: string;
  metricDescription?: string;
  attributes: Record<string, unknown>;
  resourceAttributes: Record<string, unknown>;
  value?: number;
  observedAt?: string;
  occurredAt?: string;
}

export function extractLogRecords(payload: unknown): NormalizedOtelRecord[] {
  if (!isRecord(payload)) return [];
  const resourceLogs = asArray(payload.resourceLogs);
  const records: NormalizedOtelRecord[] = [];

  for (const resourceLog of resourceLogs) {
    if (!isRecord(resourceLog)) continue;
    const resourceAttributes = attributesFrom(resourceLog.resource);
    for (const scopeLog of asArray(resourceLog.scopeLogs)) {
      if (!isRecord(scopeLog)) continue;
      for (const logRecord of asArray(scopeLog.logRecords)) {
        if (!isRecord(logRecord)) continue;
        const attributes = attributesFrom(logRecord);
        records.push({
          name: stringFrom(attributes["event.name"] ?? attributes.name),
          body: anyValueToJson(logRecord.body),
          attributes,
          resourceAttributes,
          observedAt: timestampFrom(logRecord.observedTimeUnixNano),
          occurredAt: timestampFrom(logRecord.timeUnixNano),
          severity: stringFrom(logRecord.severityText),
        });
      }
    }
  }

  return records;
}

export function extractMetricPoints(payload: unknown): NormalizedOtelMetricPoint[] {
  if (!isRecord(payload)) return [];
  const resourceMetrics = asArray(payload.resourceMetrics);
  const points: NormalizedOtelMetricPoint[] = [];

  for (const resourceMetric of resourceMetrics) {
    if (!isRecord(resourceMetric)) continue;
    const resourceAttributes = attributesFrom(resourceMetric.resource);
    for (const scopeMetric of asArray(resourceMetric.scopeMetrics)) {
      if (!isRecord(scopeMetric)) continue;
      for (const metric of asArray(scopeMetric.metrics)) {
        if (!isRecord(metric)) continue;
        const dataPoints = metricDataPoints(metric);
        for (const point of dataPoints) {
          if (!isRecord(point)) continue;
          const value = numberFrom(point.asDouble ?? point.asInt ?? point.value);
          points.push({
            metricName: stringFrom(metric.name) ?? "unknown_metric",
            metricDescription: stringFrom(metric.description),
            attributes: attributesFrom(point),
            resourceAttributes,
            value,
            observedAt: timestampFrom(point.timeUnixNano),
            occurredAt: timestampFrom(point.startTimeUnixNano),
          });
        }
      }
    }
  }

  return points;
}

export function otelRecordToUsageEvent(
  record: NormalizedOtelRecord,
  source: CollectorSource,
  identity: CollectorIdentity,
  defaults: { receivedAt?: string; agent: string; includePrompts?: boolean },
): InternalUsageEvent | null {
  const attrs = { ...record.resourceAttributes, ...record.attributes };
  const inputTokens = pickNumber(attrs, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "input_token_count",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.prompt_tokens",
  ]);
  const outputTokens = pickNumber(attrs, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "output_token_count",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.completion_tokens",
  ]);
  const totalTokens = pickNumber(attrs, [
    "total_tokens",
    "totalTokens",
    "tool_token_count",
    "gen_ai.usage.total_tokens",
  ]);
  const cacheReadTokens = pickNumber(attrs, [
    "cache_read_tokens",
    "cacheReadTokens",
    "cache_read_input_tokens",
    "cached_token_count",
    "gen_ai.usage.cache_read_input_tokens",
  ]);
  const cacheWriteTokens = pickNumber(attrs, [
    "cache_write_tokens",
    "cacheWriteTokens",
    "cache_creation_input_tokens",
    "gen_ai.usage.cache_creation_input_tokens",
  ]);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return null;
  }

  const occurredAt =
    pickString(attrs, ["event.timestamp"]) ??
    record.occurredAt ??
    record.observedAt ??
    defaults.receivedAt ??
    new Date().toISOString();
  const runId = pickString(attrs, ["session.id", "session_id", "conversation.id", "thread.id", "run.id", "runId"]);
  const stepId = pickString(attrs, ["message.id", "request.id", "span.id", "step.id", "stepId"]);
  const model = pickString(attrs, ["model", "gen_ai.request.model", "gen_ai.response.model", "ai.model"]);
  const provider = inferProvider(
    pickString(attrs, ["provider", "gen_ai.provider.name", "gen_ai.system", "ai.provider"]),
    model,
    defaults.agent,
  );
  const costUsd = pickNumber(attrs, ["cost_usd", "costUsd", "total_cost_usd", "gen_ai.usage.cost_usd"]);
  const latencyMs = pickNumber(attrs, [
    "latency_ms",
    "latencyMs",
    "duration_ms",
    "durationMs",
    "gen_ai.response.latency_ms",
  ]);
  const sourceEventId =
    pickString(attrs, ["event.id", "event_id", "id"]) ??
    hashSourceEventId(defaults.agent, record.name, occurredAt, runId, stepId, attrs, record.body);

  return normalizeInternalUsageEvent({
    ...source,
    ...identity,
    provider,
    model,
    runId,
    stepId,
    sourceEventId,
    occurredAt,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    costUsd,
    ...(costUsd !== undefined ? { costBasis: "reported" } : {}),
    latencyMs,
    status: statusFrom(record.severity, attrs),
    metadata: redactMetadata({
      eventName: record.name,
      ...(defaults.includePrompts
        ? { body: typeof record.body === "string" ? truncate(record.body, 300) : record.body }
        : {}),
      attributes: sanitizeAttributes(attrs),
    }) as JsonRecord,
  });
}

export function otelMetricPointToUsageEvent(
  point: NormalizedOtelMetricPoint,
  source: CollectorSource,
  identity: CollectorIdentity,
  defaults: { receivedAt?: string; agent: string; includePrompts?: boolean },
): InternalUsageEvent | null {
  const attrs = { ...point.resourceAttributes, ...point.attributes };
  const metricName = point.metricName.toLowerCase();
  const value = point.value;
  if (value === undefined) return null;

  const tokenPatch: Partial<
    Pick<InternalUsageEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens">
  > = {};

  if (metricName.includes("input") || metricName.includes("prompt")) tokenPatch.inputTokens = value;
  else if (metricName.includes("output") || metricName.includes("completion")) tokenPatch.outputTokens = value;
  else if (metricName.includes("cache") && metricName.includes("read")) tokenPatch.cacheReadTokens = value;
  else if (metricName.includes("cache") && (metricName.includes("write") || metricName.includes("creation"))) {
    tokenPatch.cacheWriteTokens = value;
  } else if (metricName.includes("token")) {
    tokenPatch.totalTokens = value;
  } else {
    return null;
  }

  const occurredAt = point.observedAt ?? point.occurredAt ?? defaults.receivedAt ?? new Date().toISOString();
  const runId = pickString(attrs, ["session.id", "session_id", "conversation.id", "thread.id", "run.id", "runId"]);
  const model = pickString(attrs, ["model", "gen_ai.request.model", "gen_ai.response.model", "ai.model"]);
  const provider = inferProvider(
    pickString(attrs, ["provider", "gen_ai.provider.name", "gen_ai.system", "ai.provider"]),
    model,
    defaults.agent,
  );
  const sourceEventId = stableSourceEventId([
    defaults.agent,
    "metric",
    hashObject({ metricName: point.metricName, occurredAt, runId, model, attrs }),
  ]);

  return normalizeInternalUsageEvent({
    ...source,
    ...identity,
    provider,
    model,
    runId,
    sourceEventId,
    occurredAt,
    ...tokenPatch,
    status: "unknown",
    metadata: redactMetadata({
      metricName: point.metricName,
      metricDescription: point.metricDescription,
      attributes: sanitizeAttributes(attrs),
    }) as JsonRecord,
  });
}

export function pickString(attrs: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    const string = stringFrom(value);
    if (string) return string;
  }
  return undefined;
}

export function pickNumber(attrs: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberFrom(attrs[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function inferProvider(
  reportedProvider: string | undefined,
  model: string | undefined,
  agent?: string,
): string | undefined {
  if (reportedProvider) return reportedProvider;
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (normalizedModel.startsWith("claude")) return "anthropic";
  if (/^(gpt(?:-|$)|o\d(?:-|$)|chatgpt(?:-|$))/.test(normalizedModel)) return "openai";
  if (agent === "claude-code") return "anthropic";
  if (agent === "codex") return "openai";
  return undefined;
}

function metricDataPoints(metric: Record<string, unknown>): unknown[] {
  for (const key of ["sum", "gauge", "histogram"]) {
    const value = metric[key];
    if (isRecord(value)) return asArray(value.dataPoints);
  }
  return [];
}

function attributesFrom(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const attributes = asArray(value.attributes);
  const output: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (!isRecord(attribute)) continue;
    const key = stringFrom(attribute.key);
    if (!key) continue;
    output[key] = anyValueToJson(attribute.value);
  }
  return output;
}

function anyValueToJson(value: unknown): JsonValue | undefined {
  if (!isRecord(value)) return valueToJson(value);
  if ("stringValue" in value) return stringFrom(value.stringValue) ?? "";
  if ("boolValue" in value) return Boolean(value.boolValue);
  if ("intValue" in value) return numberFrom(value.intValue) ?? 0;
  if ("doubleValue" in value) return numberFrom(value.doubleValue) ?? 0;
  if ("bytesValue" in value) return "[bytes]";
  if ("arrayValue" in value && isRecord(value.arrayValue)) {
    return asArray(value.arrayValue.values).map((item) => anyValueToJson(item) ?? null);
  }
  if ("kvlistValue" in value && isRecord(value.kvlistValue)) {
    const output: JsonRecord = {};
    for (const item of asArray(value.kvlistValue.values)) {
      if (!isRecord(item)) continue;
      const key = stringFrom(item.key);
      if (key) output[key] = anyValueToJson(item.value) ?? null;
    }
    return output;
  }
  return valueToJson(value);
}

function valueToJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map((item) => valueToJson(item) ?? null);
  if (typeof value === "object") {
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = valueToJson(nested) ?? null;
    }
    return output;
  }
  return String(value);
}

function timestampFrom(value: unknown): string | undefined {
  const string = stringFrom(value);
  if (!string) return undefined;
  const asNumber = Number(string);
  if (!Number.isFinite(asNumber)) return undefined;
  const millis = string.length > 13 ? Math.floor(asNumber / 1_000_000) : asNumber;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function statusFrom(severity: string | undefined, attrs: Record<string, unknown>): "success" | "error" | "unknown" {
  const status = pickString(attrs, ["status", "status.code", "gen_ai.response.finish_reason"]);
  if (status && /error|fail/i.test(status)) return "error";
  if (severity && /error|fatal/i.test(severity)) return "error";
  if (status && /success|ok|stop|complete/i.test(status)) return "success";
  return "unknown";
}

function sanitizeAttributes(attrs: Record<string, unknown>): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!isAllowedMetadataAttribute(key)) continue;
    output[key] = valueToJson(value) ?? null;
  }
  return output;
}

function isAllowedMetadataAttribute(key: string): boolean {
  return /^(event\.name|service\.(name|version)|deployment\.environment|environment|agent(\.|_)version|tool(\.|_)version|provider|model|gen_ai\.(system|request\.model|response\.(model|finish_reason))|status(\.code)?|(session|conversation|thread|run|step|span|request)\.(id|name)|runId|stepId)$/i.test(
    key,
  );
}

function hashSourceEventId(
  agent: string,
  eventName: string | undefined,
  occurredAt: string,
  runId: string | undefined,
  stepId: string | undefined,
  attrs: Record<string, unknown>,
  body: unknown,
): string {
  return stableSourceEventId([agent, "log", hashObject({ eventName, occurredAt, runId, stepId, attrs, body })]);
}

function hashObject(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
