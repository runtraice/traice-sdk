import { CostAdapter, CostEvent, EventMetadata } from "../types";
import { calculateCost } from "../pricing";
import * as crypto from "crypto";

export interface CloudAdapterConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Maximum number of exact responses retained by this process. Default: 1000. */
  exactCacheMaxEntries?: number;
  /** Timeout for rules and decision API calls. Default: 2000. */
  enforcementTimeoutMs?: number;
}

export interface ExactCacheRequest {
  model: string;
  messages?: unknown;
  [parameter: string]: unknown;
}

export interface ExactCacheContext {
  feature?: string;
  retryCount?: number;
  /** Provider override for custom response shapes and authoritative cost calculation. */
  provider?: CostEvent["provider"];
  /** Explicit per-call bypass. */
  bypass?: boolean;
  /** A `true`/`1` x-traice-cache-bypass header bypasses lookup and storage. */
  headers?: Headers | Record<string, string | string[] | undefined>;
}

export interface ExactCacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  size: number;
  hitRate: number;
  savingsUsd: number;
}

type CacheRule = {
  id: string;
  name: string;
  state: "DRAFT" | "SHADOW" | "ACTIVE" | "DISABLED";
  priority: number;
  condition: Record<string, unknown>;
  action: string;
  actionParams: Record<string, unknown>;
  requireEquivalencePct: number | null;
  modelAllowlist: string[];
};

type ExactCacheEntry = {
  response: unknown;
  expiresAt: number;
  costBasis: ExactCacheCostBasis;
};

type ExactCacheCostBasis = {
  provider: CostEvent["provider"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  savingsUsdMicros: number;
};

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
  private exactCache = new Map<string, ExactCacheEntry>();
  private exactCacheMaxEntries: number;
  private enforcementTimeoutMs: number;
  private rules: CacheRule[] = [];
  private rulesFetchedAt = 0;
  private rulesTtlMs = 60_000;
  private pendingDecisions = new Set<Promise<void>>();
  private exactCacheHits = 0;
  private exactCacheMisses = 0;
  private exactCacheBypasses = 0;
  private exactCacheSavingsUsdMicros = 0;

  constructor(config: CloudAdapterConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint ?? "https://runtraice.com/api/v1/events";
    this.batchSize = config.batchSize ?? 50;
    this.exactCacheMaxEntries = Math.max(1, Math.floor(config.exactCacheMaxEntries ?? 1000));
    this.enforcementTimeoutMs = Math.max(100, Math.floor(config.enforcementTimeoutMs ?? 2000));
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
    await Promise.allSettled(Array.from(this.pendingDecisions));
  }

  /**
   * Run an LLM request through an active exact-cache guardrail.
   *
   * Streaming requests are always passed through because provider stream
   * objects are one-shot and cannot be replayed safely from an object cache.
   * Rules, cache bookkeeping, and decision telemetry fail open.
   */
  async enforceExactCache<T>(
    request: ExactCacheRequest,
    providerCall: () => Promise<T>,
    context: ExactCacheContext = {},
  ): Promise<T> {
    if (request.stream === true || cacheBypassed(context)) {
      this.exactCacheBypasses++;
      return providerCall();
    }

    let rule: CacheRule;
    let key: string;
    try {
      const rulesAvailable = await this.refreshRules();
      if (!rulesAvailable) return providerCall();

      const matchedRule = this.matchExactCacheRule(request, context);
      if (!matchedRule) return providerCall();
      rule = matchedRule;

      key = exactCacheKey(this.apiKey, rule.id, request);
      const cached = this.getExactCache(key);
      if (cached) {
        this.exactCacheHits++;
        this.exactCacheSavingsUsdMicros += cached.costBasis.savingsUsdMicros;
        this.trackDecision(this.postExactCacheDecision(rule, request.model, cached.costBasis));
        return cached.response as T;
      }
      this.exactCacheMisses++;
      this.trackDecision(this.postExactCacheMiss(rule, request.model));
    } catch {
      return providerCall();
    }

    // Provider errors propagate exactly once. Cache bookkeeping must never
    // retry a customer request behind their back.
    const response = await providerCall();
    try {
      const ttlSeconds = boundedTtlSeconds(rule.actionParams.cacheTtlSec);
      this.setExactCache(key, {
        response,
        expiresAt: Date.now() + ttlSeconds * 1000,
        costBasis: responseCostBasis(response, context.provider),
      });
    } catch {
      // A cache write/costing failure does not affect the provider response.
    }
    return response;
  }

  /** Process-local metrics for active exact-cache rules. */
  getExactCacheStats(): ExactCacheStats {
    const attempts = this.exactCacheHits + this.exactCacheMisses;
    return {
      hits: this.exactCacheHits,
      misses: this.exactCacheMisses,
      bypasses: this.exactCacheBypasses,
      size: this.exactCache.size,
      hitRate: attempts > 0 ? this.exactCacheHits / attempts : 0,
      savingsUsd: this.exactCacheSavingsUsdMicros / 1_000_000,
    };
  }

  private async refreshRules(): Promise<boolean> {
    if (this.rulesFetchedAt > 0 && Date.now() - this.rulesFetchedAt < this.rulesTtlMs) return true;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.enforcementTimeoutMs);
    try {
      const response = await fetch(this.siblingEndpoint("rules"), {
        headers: { Authorization: `Bearer ${this.apiKey}`, "X-Source": "traice-sdk" },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const json = (await response.json()) as { rules?: unknown; ttlSeconds?: unknown };
      this.rules = Array.isArray(json.rules) ? json.rules.filter(isCacheRule) : [];
      const ttlSeconds = Number(json.ttlSeconds ?? 60);
      this.rulesTtlMs = Number.isFinite(ttlSeconds) ? Math.max(1000, ttlSeconds * 1000) : 60_000;
      this.rulesFetchedAt = Date.now();
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private matchExactCacheRule(request: ExactCacheRequest, context: ExactCacheContext): CacheRule | undefined {
    const ordered = this.rules
      .filter((rule) => rule.state === "ACTIVE" || rule.state === "SHADOW")
      .sort((a, b) => a.priority - b.priority);
    for (const rule of ordered) {
      if (!ruleMatches(rule, request.model, context)) continue;
      return rule.state === "ACTIVE" && rule.action === "CACHE_EXACT" ? rule : undefined;
    }
    return undefined;
  }

  private getExactCache(key: string): ExactCacheEntry | undefined {
    const entry = this.exactCache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.exactCache.delete(key);
      return undefined;
    }
    this.exactCache.delete(key);
    this.exactCache.set(key, entry);
    return entry;
  }

  private setExactCache(key: string, entry: ExactCacheEntry): void {
    this.exactCache.delete(key);
    this.exactCache.set(key, entry);
    while (this.exactCache.size > this.exactCacheMaxEntries) {
      const oldest = this.exactCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.exactCache.delete(oldest);
    }
  }

  private postExactCacheDecision(
    rule: CacheRule,
    requestedModel: string,
    costBasis: ExactCacheCostBasis,
  ): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      cacheOutcome: "hit",
      requestedModel,
      provider: costBasis.provider,
      servedModel: costBasis.model,
      inputTokens: costBasis.inputTokens,
      outputTokens: costBasis.outputTokens,
      cacheReadTokens: costBasis.cacheReadTokens,
      cacheWriteTokens: costBasis.cacheWriteTokens,
    });
  }

  private postExactCacheMiss(rule: CacheRule, requestedModel: string): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      cacheOutcome: "miss",
      requestedModel,
    });
  }

  private trackDecision(promise: Promise<void>): void {
    this.pendingDecisions.add(promise);
    promise.finally(() => this.pendingDecisions.delete(promise)).catch(() => {});
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.enforcementTimeoutMs);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Source": "traice-sdk",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Decision telemetry is best-effort and never affects the cached result.
    } finally {
      clearTimeout(timeout);
    }
  }

  private siblingEndpoint(resource: "rules" | "decisions"): string {
    const url = new URL(this.endpoint);
    url.pathname = url.pathname.replace(/\/events\/?$/, `/${resource}`);
    return url.toString();
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

function isCacheRule(value: unknown): value is CacheRule {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Partial<CacheRule>;
  return (
    typeof rule.id === "string" &&
    typeof rule.name === "string" &&
    typeof rule.state === "string" &&
    typeof rule.priority === "number" &&
    typeof rule.action === "string" &&
    rule.condition != null &&
    typeof rule.condition === "object" &&
    rule.actionParams != null &&
    typeof rule.actionParams === "object" &&
    (rule.requireEquivalencePct === null || typeof rule.requireEquivalencePct === "number") &&
    Array.isArray(rule.modelAllowlist)
  );
}

function ruleMatches(rule: CacheRule, model: string, context: ExactCacheContext): boolean {
  if (!conditionMatches(rule.condition, model, context)) return false;
  if (rule.action !== "SWAP" && rule.action !== "DOWNGRADE" && rule.action !== "ROUTE") return true;

  const targetModel = typeof rule.actionParams.targetModel === "string" ? rule.actionParams.targetModel : null;
  if (targetModel && rule.modelAllowlist.length > 0 && !rule.modelAllowlist.includes(targetModel)) return false;
  return rule.requireEquivalencePct == null;
}

function conditionMatches(condition: Record<string, unknown>, model: string, context: ExactCacheContext): boolean {
  switch (condition.type) {
    case "always":
      return true;
    case "model":
      return model === condition.equals;
    case "feature":
      return context.feature === condition.equals;
    case "retry":
      return (context.retryCount ?? 0) >= Number(condition.gte ?? 0);
    default:
      return false;
  }
}

function boundedTtlSeconds(value: unknown): number {
  const ttl = Math.round(Number(value));
  return Number.isFinite(ttl) ? Math.max(1, Math.min(86_400, ttl)) : 300;
}

function cacheBypassed(context: ExactCacheContext): boolean {
  if (context.bypass) return true;
  const headers = context.headers;
  let value: string | null | undefined;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    value = headers.get("x-traice-cache-bypass");
  } else if (headers) {
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === "x-traice-cache-bypass");
    value = Array.isArray(match?.[1]) ? match?.[1][0] : match?.[1];
  }
  return value === "1" || value?.toLowerCase() === "true";
}

function exactCacheKey(apiKey: string, ruleId: string, request: ExactCacheRequest): string {
  const workspaceScope = crypto.createHash("sha256").update(apiKey).digest("hex");
  return crypto.createHash("sha256").update(stableStringify({ workspaceScope, ruleId, request })).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalizeJson(nested)]),
    );
  }
  return value;
}

function responseCostBasis(response: unknown, providerOverride?: CostEvent["provider"]): ExactCacheCostBasis {
  const value = response as {
    type?: unknown;
    object?: unknown;
    model?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      prompt_tokens_details?: { cached_tokens?: unknown };
    };
  };
  const model = typeof value?.model === "string" ? value.model : "unknown";
  const provider =
    providerOverride ??
    (value?.type === "message"
      ? "anthropic"
      : value?.object === "response" || value?.usage?.prompt_tokens !== undefined
        ? "openai"
        : "custom");
  const anthropic = provider === "anthropic";
  const cacheRead = nonNegativeNumber(
    anthropic
      ? value?.usage?.cache_read_input_tokens
      : (value?.usage?.input_tokens_details?.cached_tokens ?? value?.usage?.prompt_tokens_details?.cached_tokens),
  );
  const cacheWrite = nonNegativeNumber(anthropic ? value?.usage?.cache_creation_input_tokens : 0);
  const rawInput = nonNegativeNumber(
    anthropic ? value?.usage?.input_tokens : (value?.usage?.input_tokens ?? value?.usage?.prompt_tokens),
  );
  const input = anthropic ? rawInput + cacheRead + cacheWrite : rawInput;
  const output = nonNegativeNumber(
    anthropic ? value?.usage?.output_tokens : (value?.usage?.output_tokens ?? value?.usage?.completion_tokens),
  );
  const { totalCostUSD } = calculateCost(provider, model, input, output, cacheRead, cacheWrite);
  return {
    provider,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    savingsUsdMicros: Math.max(0, Math.round(totalCostUSD * 1_000_000)),
  };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
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
