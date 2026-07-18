export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = Record<string, JsonValue>;

export type InternalUsageCategory = "coding_agent" | "chat_agent" | "ide_assistant" | "other";

export type InternalUsageStatus = "success" | "error" | "unknown";

export interface InternalUsageEvent {
  sourceKey: string;
  sourceName?: string;
  sourceKind: string;
  tool: string;
  category: InternalUsageCategory;
  employeeEmail?: string;
  employeeName?: string;
  employeeExternalId?: string;
  teamName?: string;
  teamExternalId?: string;
  seatMonthlyUsd?: number;
  sourcePrincipal?: string;
  provider?: string;
  model?: string;
  runId?: string;
  stepId?: string;
  sourceEventId: string;
  occurredAt: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costBasis?: string;
  status?: InternalUsageStatus;
  metadata?: JsonRecord;
}

export interface ProductUsageEvent {
  id: string;
  timestamp: string;
  provider: "openai" | "anthropic" | "custom";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputCostUSD: number;
  outputCostUSD: number;
  totalCostUSD: number;
  latencyMs: number;
  status?: "success" | "error";
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
  sessionId?: string;
  env?: string;
  metadata?: JsonRecord;
  tags?: Record<string, string>;
}

export interface CollectorIdentity {
  employeeEmail?: string;
  employeeName?: string;
  employeeExternalId?: string;
  teamName?: string;
  teamExternalId?: string;
  sourcePrincipal?: string;
  seatMonthlyUsd?: number;
}

export interface CollectorSource {
  sourceKey: string;
  sourceName?: string;
  sourceKind: string;
  tool: string;
  category: InternalUsageCategory;
}

export function normalizeInternalUsageEvent(event: InternalUsageEvent): InternalUsageEvent {
  const inputTokens = normalizeTokenCount(event.inputTokens);
  const outputTokens = normalizeTokenCount(event.outputTokens);
  const cacheReadTokens = normalizeTokenCount(event.cacheReadTokens);
  const cacheWriteTokens = normalizeTokenCount(event.cacheWriteTokens);
  const totalTokens =
    normalizeTokenCount(event.totalTokens) ?? sumDefined(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

  return {
    ...event,
    sourceKey: event.sourceKey.trim(),
    sourceKind: event.sourceKind.trim(),
    tool: event.tool.trim(),
    category: event.category,
    sourceEventId: event.sourceEventId.trim(),
    occurredAt: normalizeIsoTimestamp(event.occurredAt),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(event.status ? { status: event.status } : { status: "unknown" }),
  };
}

export function assertValidInternalUsageEvent(event: InternalUsageEvent): void {
  const missing = [];
  if (!event.sourceKey?.trim()) missing.push("sourceKey");
  if (!event.sourceKind?.trim()) missing.push("sourceKind");
  if (!event.tool?.trim()) missing.push("tool");
  if (!event.category?.trim()) missing.push("category");
  if (!event.sourceEventId?.trim()) missing.push("sourceEventId");
  if (!event.occurredAt?.trim()) missing.push("occurredAt");

  if (missing.length > 0) {
    throw new Error(`Internal usage event is missing required fields: ${missing.join(", ")}`);
  }

  normalizeIsoTimestamp(event.occurredAt);
}

export function redactMetadata(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (typeof value === "object") {
    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactMetadata(nested);
      }
    }
    return output;
  }
  return null;
}

export function stableSourceEventId(parts: Array<string | number | undefined | null>): string {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part))
    .join(":");
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

function normalizeIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, value) => sum + value, 0);
}

function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|cookie|password|secret|token/i.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/sk-[a-zA-Z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/gh[opsu]_[a-zA-Z0-9]{12,}/g, "gh_[redacted]")
    .replace(/traice_[a-zA-Z0-9_-]{12,}/g, "traice_[redacted]");
}
