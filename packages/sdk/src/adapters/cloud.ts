import { CostAdapter, CostEvent, EventMetadata } from "../types";

export interface CloudAdapterConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface CloudCostEvent {
  ts: string;
  provider: CostEvent["provider"];
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
  prompt?: string;
  output?: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  latencyMs?: number;
  status?: CostEvent["status"];
  metadata: CloudEventMetadata;
}

export type CloudEventMetadata = EventMetadata & {
  errorMessage?: string;
  cached?: boolean;
  promptName?: string;
  promptVersion?: string;
  sessionId?: string;
  env?: string;
  tags?: Record<string, string>;
};

/**
 * Cloud adapter that sends cost events to the @traice/sdk cloud service.
 * Events are batched and flushed periodically for efficiency.
 *
 * @example
 * ```typescript
 * configure({
 *   adapters: ['local', 'cloud'],
 *   cloudApiKey: 'lm_live_abc123',
 * });
 * ```
 */
export class CloudAdapter implements CostAdapter {
  name = "cloud";
  private apiKey: string;
  private endpoint: string;
  private batchSize: number;
  private buffer: CostEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CloudAdapterConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint ?? "https://runtraice.com/api/v1/events";
    this.batchSize = config.batchSize ?? 50;
    const flushMs = config.flushIntervalMs ?? 5000;

    this.timer = setInterval(() => this.flushBuffer(), flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  async write(event: CostEvent): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      await this.flushBuffer();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      await this.flushBuffer();
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Source": "traice-sdk",
        },
        body: JSON.stringify({ events: batch.map(toCloudEvent) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`CloudAdapter failed: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
      }
    } catch (err) {
      // On failure, put events back at the front of the buffer
      // (up to batchSize to prevent unbounded growth)
      if (this.buffer.length < this.batchSize * 2) {
        this.buffer.unshift(...batch);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function toCloudEvent(event: CostEvent): CloudCostEvent {
  return omitUndefined({
    ts: event.timestamp,
    provider: event.provider,
    model: event.model,
    feature: event.feature,
    userId: event.userId,
    tenantId: event.tenantId ?? stringTag(event.tags, "tenantId"),
    agentId: event.agentId ?? stringTag(event.tags, "agentId"),
    workflowId: event.workflowId ?? stringTag(event.tags, "workflowId"),
    runId: event.runId ?? stringTag(event.tags, "runId"),
    stepId: event.stepId ?? stringTag(event.tags, "stepId"),
    toolName: event.toolName ?? stringTag(event.tags, "toolName"),
    retryCount: event.retryCount ?? numberTag(event.tags, "retryCount"),
    outcome: event.outcome ?? stringTag(event.tags, "outcome"),
    prompt: event.prompt,
    output: event.output,
    promptTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    costUsd: event.totalCostUSD,
    latencyMs: event.latencyMs,
    status: event.status,
    metadata: toCloudMetadata(event),
  });
}

function toCloudMetadata(event: CostEvent): CloudEventMetadata {
  const metadata: CloudEventMetadata = { ...(event.metadata ?? {}) };

  if (event.errorMessage !== undefined) metadata.errorMessage = event.errorMessage;
  if (event.cached !== undefined) metadata.cached = event.cached;
  if (event.promptName !== undefined) metadata.promptName = event.promptName;
  if (event.promptVersion !== undefined) metadata.promptVersion = event.promptVersion;
  if (event.sessionId !== undefined) metadata.sessionId = event.sessionId;
  if (event.env !== undefined) metadata.env = event.env;
  if (event.tags !== undefined) metadata.tags = event.tags;

  return metadata;
}

function stringTag(tags: Record<string, string> | undefined, key: string): string | undefined {
  const value = tags?.[key];
  return value && value.trim() !== "" ? value : undefined;
}

function numberTag(tags: Record<string, string> | undefined, key: string): number | undefined {
  const value = stringTag(tags, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function omitUndefined<T extends object>(value: T): T {
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) {
      delete (value as Record<string, unknown>)[key];
    }
  }
  return value;
}
