import { CostAdapter, CostEvent, EventMetadata } from "../types";
import { calculateCost } from "../pricing";
import { decide, type EnforcementRule } from "../enforcement";
import * as crypto from "crypto";
import { DurableCloudOutbox, type DurableQueuedCostEvent } from "./cloud-outbox";

export interface CloudAdapterConfig {
  apiKey: string;
  endpoint?: string;
  batchSize?: number;
  flushIntervalMs?: number;
  /** Maximum events retained in memory. The oldest event is dropped when full. Default: 1000. */
  maxQueueSize?: number;
  /** Per-request delivery timeout. Default: 10000. */
  requestTimeoutMs?: number;
  /** Attempts per delivery before the batch returns to the queue. Default: 4. */
  maxDeliveryAttempts?: number;
  /** Maximum retry delay, including server rate-limit guidance. Default: 60000. */
  maxRetryDelayMs?: number;
  /** Send prompt and output samples. Disabled by default. */
  captureContent?: boolean;
  /** Optional NDJSON path for a restart-safe delivery queue. */
  durableQueuePath?: string;
  /** Receives successful backend acknowledgement summaries. */
  onDelivery?: (summary: CloudDeliverySummary) => void;
  /** Receives background delivery failures and queue overflow errors. */
  onDeliveryError?: (error: Error) => void;
  /** Maximum number of exact responses retained by this process. Default: 1000. */
  exactCacheMaxEntries?: number;
  /** Timeout for rules and decision API calls. Default: 2000. */
  enforcementTimeoutMs?: number;
  /** Reports enforcement control-plane failures without changing fail-open behavior. */
  onEnforcementError?: (error: Error, context: EnforcementErrorContext) => void;
  /** Background refresh interval for advisory workspace budget policy. Default: 60000. */
  budgetPolicyPollIntervalMs?: number;
  /** Opt-in process-local semantic cache. No prompt content is sent to trAIce. */
  semanticCache?: SemanticCacheConfig;
}

export interface SemanticCacheConfig {
  /** Produce an embedding with infrastructure and credentials controlled by the consuming application. */
  embed: (text: string) => Promise<readonly number[]>;
  /** Maximum semantic responses retained by this process. Default: 250. */
  maxEntries?: number;
  /** Hard embedding latency budget before the request fails open. Default: 1000. */
  timeoutMs?: number;
}

export interface ExactCacheRequest {
  model: string;
  messages?: unknown;
  [parameter: string]: unknown;
}

export interface ExactCacheContext {
  feature?: string;
  userId?: string;
  retryCount?: number;
  /** Optional current-period budget utilization overrides, expressed as fractions from 0 to 1. */
  budgetPct?: Partial<Record<"workspace" | "feature" | "user", number>>;
  /** Provider override for custom response shapes and authoritative cost calculation. */
  provider?: CostEvent["provider"];
  /** Explicit per-call bypass. */
  bypass?: boolean;
  /** A `true`/`1` x-traice-cache-bypass header bypasses lookup and storage. */
  headers?: Headers | Record<string, string | string[] | undefined>;
  /** Optional text passed to the customer-supplied semantic embedder instead of the normalized request. */
  semanticCacheText?: string;
}

export type RequestEnforcementContext = ExactCacheContext;

export type EnforcementErrorContext = {
  operation: "rules_refresh" | "policy_refresh" | "decision_post";
  status?: number;
};

export type EnforcementStats = {
  ruleRefreshes: number;
  ruleRefreshFailures: number;
  decisionPosts: number;
  decisionPostFailures: number;
  failOpenRequests: number;
  policyRefreshes: number;
  policyRefreshFailures: number;
  policyChecks: number;
  policyFailOpenChecks: number;
  policyDowngradeRecommendations: number;
  policyBlocks: number;
};

export type BudgetPolicyContext = {
  feature?: string;
  userId?: string;
};

export type BudgetPolicyMatch = {
  scope: "WORKSPACE" | "FEATURE" | "USER";
  scopeValue: string | null;
  utilizationPct: number;
};

export type BudgetAdvice = {
  available: boolean;
  shouldDowngrade: boolean;
  isBlocked: boolean;
  maxUtilizationPct: number | null;
  reason: "policy_unavailable" | "within_budget" | "approaching_limit" | "budget_exceeded";
  matches: BudgetPolicyMatch[];
};

export type BlockingRuleAction = "DENY" | "CAP_RETRIES";
export type ModelRuleAction = "SWAP" | "DOWNGRADE" | "FALLBACK" | "ROUTE";

export interface EnforcementEvidence {
  experimentId: string;
  feature: string;
  sourceModel: string;
  candidateModel: string;
  equivalencePct: number;
  sampleCount: number;
}

/** A structured refusal produced by an active deny or retry-cap rule. */
export class TraiceEnforcementError extends Error {
  readonly code = "TRAICE_REQUEST_BLOCKED";

  constructor(
    readonly action: BlockingRuleAction,
    readonly ruleId: string,
    readonly ruleName: string,
    readonly requestedModel: string,
    readonly reason: Record<string, unknown>,
  ) {
    super(action === "DENY" ? `Request denied by trAIce rule: ${ruleName}` : `Retry cap reached: ${ruleName}`);
    this.name = "TraiceEnforcementError";
  }

  toJSON(): Record<string, unknown> {
    return {
      error: "traice_request_blocked",
      code: this.code,
      action: this.action,
      ruleId: this.ruleId,
      ruleName: this.ruleName,
      requestedModel: this.requestedModel,
      reason: this.reason,
    };
  }
}

export interface ExactCacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  size: number;
  hitRate: number;
  savingsUsd: number;
}

export interface SemanticCacheStats {
  hits: number;
  misses: number;
  bypasses: number;
  embeddingFailures: number;
  size: number;
  hitRate: number;
  savingsUsd: number;
}

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

type SemanticCacheEntry = {
  ruleId: string;
  requestedModel: string;
  vector: number[];
  response: unknown;
  expiresAt: number;
  costBasis: ExactCacheCostBasis;
};

type EnforcementBudgetSnapshot = {
  scope: "WORKSPACE" | "FEATURE" | "USER";
  scopeValue: string | null;
  pct: number;
};

export interface CloudCostEvent {
  source: "traice-sdk";
  externalId: string;
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

export type CloudDeliverySummary = {
  accepted: number;
  deduplicated: number;
  quotaDropped: number;
  dropped: number;
  plan?: string;
};

export type CloudDeliveryStats = {
  queued: number;
  oldestQueuedAt: string | null;
  accepted: number;
  deduplicated: number;
  quotaDropped: number;
  rejected: number;
  queueDropped: number;
  failedBatches: number;
  retries: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

type QueuedCostEvent = DurableQueuedCostEvent;

class CloudDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CloudDeliveryError";
  }
}

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
  private maxQueueSize: number;
  private requestTimeoutMs: number;
  private maxDeliveryAttempts: number;
  private maxRetryDelayMs: number;
  private captureContent: boolean;
  private durableOutbox?: DurableCloudOutbox;
  private onDelivery?: CloudAdapterConfig["onDelivery"];
  private onDeliveryError?: CloudAdapterConfig["onDeliveryError"];
  private buffer: QueuedCostEvent[] = [];
  private flushPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private policyTimer: ReturnType<typeof setInterval> | null = null;
  private exactCache = new Map<string, ExactCacheEntry>();
  private exactCacheMaxEntries: number;
  private semanticCache = new Map<string, SemanticCacheEntry>();
  private semanticCacheConfig?: SemanticCacheConfig;
  private semanticCacheMaxEntries: number;
  private semanticCacheTimeoutMs: number;
  private enforcementTimeoutMs: number;
  private onEnforcementError?: CloudAdapterConfig["onEnforcementError"];
  private rules: EnforcementRule[] = [];
  private evidence: EnforcementEvidence[] = [];
  private budgets: EnforcementBudgetSnapshot[] = [];
  private policyFetchedAt = 0;
  private policyTtlMs = 60_000;
  private policyRefresh: Promise<boolean> | null = null;
  private enforcementEnabled = true;
  private rulesFetchedAt = 0;
  private rulesTtlMs = 60_000;
  private rulesRefresh: Promise<boolean> | null = null;
  private pendingDecisions = new Set<Promise<void>>();
  private exactCacheHits = 0;
  private exactCacheMisses = 0;
  private exactCacheBypasses = 0;
  private exactCacheSavingsUsdMicros = 0;
  private semanticCacheHits = 0;
  private semanticCacheMisses = 0;
  private semanticCacheBypasses = 0;
  private semanticCacheEmbeddingFailures = 0;
  private semanticCacheSavingsUsdMicros = 0;
  private deliveryStats = {
    accepted: 0,
    deduplicated: 0,
    quotaDropped: 0,
    rejected: 0,
    queueDropped: 0,
    failedBatches: 0,
    retries: 0,
    lastSuccessAt: null as string | null,
    lastErrorAt: null as string | null,
  };
  private enforcementStats: EnforcementStats = {
    ruleRefreshes: 0,
    ruleRefreshFailures: 0,
    decisionPosts: 0,
    decisionPostFailures: 0,
    failOpenRequests: 0,
    policyRefreshes: 0,
    policyRefreshFailures: 0,
    policyChecks: 0,
    policyFailOpenChecks: 0,
    policyDowngradeRecommendations: 0,
    policyBlocks: 0,
  };

  constructor(config: CloudAdapterConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint ?? "https://runtraice.com/api/v1/events";
    this.batchSize = Math.max(1, Math.floor(config.batchSize ?? 50));
    this.maxQueueSize = Math.max(1, Math.floor(config.maxQueueSize ?? 1000));
    this.requestTimeoutMs = Math.max(100, Math.floor(config.requestTimeoutMs ?? 10_000));
    this.maxDeliveryAttempts = Math.max(1, Math.floor(config.maxDeliveryAttempts ?? 4));
    this.maxRetryDelayMs = Math.max(0, Math.floor(config.maxRetryDelayMs ?? 60_000));
    this.captureContent = config.captureContent ?? false;
    if (config.durableQueuePath) {
      this.durableOutbox = new DurableCloudOutbox(config.durableQueuePath);
      const restored = this.durableOutbox.load();
      this.buffer = restored.slice(-this.maxQueueSize);
      const restoredDropped = restored.length - this.buffer.length;
      if (restoredDropped > 0) this.deliveryStats.queueDropped += restoredDropped;
      this.durableOutbox.replaceSync(this.buffer);
    }
    this.onDelivery = config.onDelivery;
    this.onDeliveryError = config.onDeliveryError;
    this.exactCacheMaxEntries = Math.max(1, Math.floor(config.exactCacheMaxEntries ?? 1000));
    this.semanticCacheConfig = config.semanticCache;
    this.semanticCacheMaxEntries = Math.max(1, Math.floor(config.semanticCache?.maxEntries ?? 250));
    this.semanticCacheTimeoutMs = Math.max(10, Math.floor(config.semanticCache?.timeoutMs ?? 1000));
    this.enforcementTimeoutMs = Math.max(100, Math.floor(config.enforcementTimeoutMs ?? 2000));
    this.onEnforcementError = config.onEnforcementError;
    const flushMs = config.flushIntervalMs ?? 5000;
    const policyPollMs = Math.max(1000, Math.floor(config.budgetPolicyPollIntervalMs ?? 60_000));

    this.timer = setInterval(() => {
      this.flushBuffer().catch((error) => this.reportDeliveryError(asError(error)));
    }, flushMs);
    if (this.timer.unref) this.timer.unref();
    this.policyTimer = setInterval(() => this.refreshPolicyInBackground(), policyPollMs);
    if (this.policyTimer.unref) this.policyTimer.unref();
  }

  async write(event: CostEvent): Promise<void> {
    const queued = { event, enqueuedAt: Date.now() };
    let queueOverflowed = false;
    if (this.buffer.length >= this.maxQueueSize) {
      this.buffer.shift();
      this.deliveryStats.queueDropped++;
      queueOverflowed = true;
      this.reportDeliveryError(
        new Error(`CloudAdapter queue full; dropped oldest event at ${this.maxQueueSize} events`),
      );
    }
    this.buffer.push(queued);
    if (this.durableOutbox) {
      if (queueOverflowed) await this.durableOutbox.replace(this.buffer);
      else await this.durableOutbox.append(queued);
    }
    if (this.buffer.length >= this.batchSize) {
      await this.flushBuffer();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.policyTimer) {
      clearInterval(this.policyTimer);
      this.policyTimer = null;
    }
    await this.flushBuffer();
    if (this.policyRefresh) {
      await Promise.allSettled([this.policyRefresh]);
    }
    await Promise.allSettled(Array.from(this.pendingDecisions));
  }

  /** Process-local delivery health. Values reset when a new adapter is created. */
  getDeliveryStats(): CloudDeliveryStats {
    return {
      queued: this.buffer.length,
      oldestQueuedAt: this.buffer[0] ? new Date(this.buffer[0].enqueuedAt).toISOString() : null,
      ...this.deliveryStats,
    };
  }

  /** Fetch and cache the current rules and experiment evidence before serving traffic. */
  async warmEnforcement(): Promise<boolean> {
    return this.refreshRules();
  }

  /** Fetch and cache workspace budget policy before serving advisory checks. */
  async warmPolicy(): Promise<boolean> {
    return this.refreshPolicy();
  }

  /**
   * Read cached workspace budget advice without adding network latency.
   *
   * A cold or expired cache returns an explicitly unavailable, fail-open
   * result and starts a best-effort background refresh.
   */
  getBudgetAdvice(context: BudgetPolicyContext = {}): BudgetAdvice {
    this.enforcementStats.policyChecks++;
    if (!this.policyIsFresh()) {
      this.enforcementStats.policyFailOpenChecks++;
      this.refreshPolicyInBackground();
      return {
        available: false,
        shouldDowngrade: false,
        isBlocked: false,
        maxUtilizationPct: null,
        reason: "policy_unavailable",
        matches: [],
      };
    }

    const matches = this.matchingBudgets(context)
      .map((budget) => ({
        scope: budget.scope,
        scopeValue: budget.scopeValue,
        utilizationPct: budget.pct,
      }))
      .sort((left, right) => right.utilizationPct - left.utilizationPct);
    const maxUtilizationPct = matches[0]?.utilizationPct ?? 0;
    const isBlocked = maxUtilizationPct >= 100;
    const shouldDowngrade = maxUtilizationPct >= 80;
    if (isBlocked) this.enforcementStats.policyBlocks++;
    else if (shouldDowngrade) this.enforcementStats.policyDowngradeRecommendations++;
    return {
      available: true,
      shouldDowngrade,
      isBlocked,
      maxUtilizationPct,
      reason: isBlocked ? "budget_exceeded" : shouldDowngrade ? "approaching_limit" : "within_budget",
      matches,
    };
  }

  /** Return true when a matching cached budget is at or above 80%. */
  shouldDowngrade(context: BudgetPolicyContext = {}): boolean {
    return this.getBudgetAdvice(context).shouldDowngrade;
  }

  /** Return true when a matching cached budget is at or above 100%. */
  isBlocked(context: BudgetPolicyContext = {}): boolean {
    return this.getBudgetAdvice(context).isBlocked;
  }

  /**
   * Run an LLM request through an active exact-cache guardrail.
   *
   * Streaming requests are always passed through because provider stream
   * objects are one-shot and cannot be replayed safely from an object cache.
   * Rules, cache bookkeeping, and decision telemetry fail open. Call
   * warmEnforcement() during startup. A cold or expired rules cache never adds
   * a network read to the request path.
   */
  async enforceExactCache<T>(
    request: ExactCacheRequest,
    providerCall: () => Promise<T>,
    context: ExactCacheContext = {},
  ): Promise<T> {
    if (!this.enforcementEnabled || request.stream === true || cacheBypassed(context)) {
      this.exactCacheBypasses++;
      return providerCall();
    }

    if (!this.rulesAreFresh()) {
      this.enforcementStats.failOpenRequests++;
      this.refreshRulesInBackground();
      return providerCall();
    }
    try {
      const rule = this.matchExactCacheRule(request, context);
      if (!rule) return providerCall();
      return this.executeExactCacheRule(request, providerCall, context, rule);
    } catch {
      this.enforcementStats.failOpenRequests++;
      return providerCall();
    }
  }

  /**
   * Run a request through the currently supported in-path rule actions.
   *
   * Active exact- or semantic-cache rules may return a cached response. Active
   * deny and retry-cap rules throw a structured TraiceEnforcementError. Active
   * swap, downgrade, and route rules rewrite the model only with passing
   * experiment evidence. Active fallback rules make at most one configured
   * fallback call after a provider error. Shadow, unsupported, unavailable, or
   * malformed rules pass through unchanged.
   */
  async enforceRequest<T, R extends ExactCacheRequest>(
    request: R,
    providerCall: (effectiveRequest: R) => Promise<T>,
    context: RequestEnforcementContext = {},
  ): Promise<T> {
    if (context.bypass || !this.enforcementEnabled) return providerCall(request);
    if (!this.rulesAreFresh()) {
      this.enforcementStats.failOpenRequests++;
      this.refreshRulesInBackground();
      return providerCall(request);
    }

    let decision: ReturnType<typeof decide>;
    let rule: EnforcementRule | undefined;
    try {
      decision = decide(
        { model: request.model, feature: context.feature, retryCount: context.retryCount },
        this.rules,
        this.decisionContext(request, context),
      );
      if (!decision.matched || decision.mode !== "active") return providerCall(request);

      rule = this.rules.find((candidate) => candidate.id === decision.ruleId);
      if (!rule) return providerCall(request);
    } catch {
      this.enforcementStats.failOpenRequests++;
      return providerCall(request);
    }

    if (decision.action === "CACHE_EXACT") {
      return this.executeExactCacheRule(request, () => providerCall(request), context, rule);
    }

    if (decision.action === "CACHE_SEMANTIC") {
      return this.executeSemanticCacheRule(request, () => providerCall(request), context, rule);
    }

    if (decision.action === "DENY" || decision.action === "CAP_RETRIES") {
      this.trackDecision(
        this.postBlockingDecision(rule, request.model, decision.action, context.retryCount, decision.reason),
      );
      throw new TraiceEnforcementError(
        decision.action,
        decision.ruleId,
        decision.ruleName,
        request.model,
        decision.reason,
      );
    }

    if (decision.action === "SWAP" || decision.action === "DOWNGRADE" || decision.action === "ROUTE") {
      if (!decision.servedModel || !decision.evidence?.satisfied || !decision.evidence.experimentId) {
        return providerCall(request);
      }
      const effectiveRequest = { ...request, model: decision.servedModel } as R;
      const response = await providerCall(effectiveRequest);
      const costBasis = responseCostBasis(response, context.provider);
      this.trackDecision(
        this.postModelDecision(
          rule,
          decision.action,
          request.model,
          decision.servedModel,
          context.feature,
          decision.evidence.experimentId,
          costBasis,
        ),
      );
      return response;
    }

    if (decision.action === "FALLBACK" && decision.servedModel) {
      return this.executeFallbackRule(request, providerCall, context, rule, decision.servedModel, decision.reason);
    }

    return providerCall(request);
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

  /** Process-local metrics for active semantic-cache rules. */
  getSemanticCacheStats(): SemanticCacheStats {
    const attempts = this.semanticCacheHits + this.semanticCacheMisses;
    return {
      hits: this.semanticCacheHits,
      misses: this.semanticCacheMisses,
      bypasses: this.semanticCacheBypasses,
      embeddingFailures: this.semanticCacheEmbeddingFailures,
      size: this.semanticCache.size,
      hitRate: attempts > 0 ? this.semanticCacheHits / attempts : 0,
      savingsUsd: this.semanticCacheSavingsUsdMicros / 1_000_000,
    };
  }

  /** Process-local enforcement control-plane health. */
  getEnforcementStats(): EnforcementStats {
    return { ...this.enforcementStats };
  }

  private async refreshRules(): Promise<boolean> {
    if (this.rulesFetchedAt > 0 && Date.now() - this.rulesFetchedAt < this.rulesTtlMs) return true;
    if (this.rulesRefresh) return this.rulesRefresh;

    const refresh = this.fetchRules();
    this.rulesRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.rulesRefresh === refresh) this.rulesRefresh = null;
    }
  }

  private async refreshPolicy(): Promise<boolean> {
    if (this.policyIsFresh()) return true;
    if (this.policyRefresh) return this.policyRefresh;

    const refresh = this.fetchPolicy();
    this.policyRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.policyRefresh === refresh) this.policyRefresh = null;
    }
  }

  private async fetchPolicy(): Promise<boolean> {
    this.enforcementStats.policyRefreshes++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.enforcementTimeoutMs);
    try {
      const response = await fetch(this.siblingEndpoint("policy"), {
        headers: { Authorization: `Bearer ${this.apiKey}`, "X-Source": "traice-sdk" },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.reportEnforcementFailure(new Error(`Policy refresh failed with HTTP ${response.status}`), {
          operation: "policy_refresh",
          status: response.status,
        });
        return false;
      }
      const json = (await response.json()) as { budgets?: unknown; ttlSeconds?: unknown };
      this.budgets = Array.isArray(json.budgets) ? json.budgets.filter(isEnforcementBudgetSnapshot) : [];
      const ttlSeconds = Number(json.ttlSeconds ?? 60);
      this.policyTtlMs = Number.isFinite(ttlSeconds) ? Math.max(1000, ttlSeconds * 1000) : 60_000;
      this.policyFetchedAt = Date.now();
      return true;
    } catch (error) {
      this.reportEnforcementFailure(asError(error), { operation: "policy_refresh" });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchRules(): Promise<boolean> {
    this.enforcementStats.ruleRefreshes++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.enforcementTimeoutMs);
    try {
      const response = await fetch(this.siblingEndpoint("rules"), {
        headers: { Authorization: `Bearer ${this.apiKey}`, "X-Source": "traice-sdk" },
        signal: controller.signal,
      });
      if (!response.ok) {
        this.reportEnforcementFailure(new Error(`Rule refresh failed with HTTP ${response.status}`), {
          operation: "rules_refresh",
          status: response.status,
        });
        return false;
      }
      const json = (await response.json()) as {
        enabled?: unknown;
        rules?: unknown;
        evidence?: unknown;
        budgets?: unknown;
        ttlSeconds?: unknown;
      };
      this.enforcementEnabled = json.enabled !== false;
      this.rules = Array.isArray(json.rules) ? json.rules.filter(isCacheRule) : [];
      this.evidence = Array.isArray(json.evidence) ? json.evidence.filter(isEnforcementEvidence) : [];
      this.budgets = Array.isArray(json.budgets) ? json.budgets.filter(isEnforcementBudgetSnapshot) : [];
      const ttlSeconds = Number(json.ttlSeconds ?? 60);
      this.rulesTtlMs = Number.isFinite(ttlSeconds) ? Math.max(1000, ttlSeconds * 1000) : 60_000;
      this.rulesFetchedAt = Date.now();
      return true;
    } catch (error) {
      this.reportEnforcementFailure(asError(error), { operation: "rules_refresh" });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private rulesAreFresh(): boolean {
    return this.rulesFetchedAt > 0 && Date.now() - this.rulesFetchedAt < this.rulesTtlMs;
  }

  private refreshRulesInBackground(): void {
    void this.refreshRules().catch(() => false);
  }

  private policyIsFresh(): boolean {
    return this.policyFetchedAt > 0 && Date.now() - this.policyFetchedAt < this.policyTtlMs;
  }

  private refreshPolicyInBackground(): void {
    void this.refreshPolicy().catch(() => false);
  }

  private matchingBudgets(context: BudgetPolicyContext): EnforcementBudgetSnapshot[] {
    return this.budgets.filter((budget) => {
      if (budget.scope === "WORKSPACE") return true;
      if (budget.scope === "FEATURE") return Boolean(context.feature) && budget.scopeValue === context.feature;
      return Boolean(context.userId) && budget.scopeValue === context.userId;
    });
  }

  private matchExactCacheRule(request: ExactCacheRequest, context: ExactCacheContext): EnforcementRule | undefined {
    const decision = decide(
      { model: request.model, feature: context.feature, retryCount: context.retryCount },
      this.rules,
      this.decisionContext(request, context),
    );
    if (!decision.matched || decision.mode !== "active" || decision.action !== "CACHE_EXACT") return undefined;
    return this.rules.find((rule) => rule.id === decision.ruleId);
  }

  private decisionContext(request: ExactCacheRequest, context: RequestEnforcementContext) {
    const matchingEvidence = (candidateModel: string): EnforcementEvidence | undefined =>
      this.evidence.find(
        (candidate) =>
          candidate.feature === context.feature &&
          candidate.sourceModel === request.model &&
          candidate.candidateModel === candidateModel,
      );
    return {
      budgetPct: mergeBudgetPct(this.budgetPctFor(context), context.budgetPct),
      equivalencePctFor: (candidateModel: string) => matchingEvidence(candidateModel)?.equivalencePct ?? null,
      experimentIdFor: (candidateModel: string) => matchingEvidence(candidateModel)?.experimentId ?? null,
    };
  }

  private budgetPctFor(context: RequestEnforcementContext): Partial<Record<"workspace" | "feature" | "user", number>> {
    const budgetPct: Partial<Record<"workspace" | "feature" | "user", number>> = {};
    for (const budget of this.budgets) {
      const fraction = Math.max(0, budget.pct / 100);
      if (budget.scope === "WORKSPACE") {
        budgetPct.workspace = Math.max(budgetPct.workspace ?? 0, fraction);
      } else if (budget.scope === "FEATURE" && context.feature && budget.scopeValue === context.feature) {
        budgetPct.feature = Math.max(budgetPct.feature ?? 0, fraction);
      } else if (budget.scope === "USER" && context.userId && budget.scopeValue === context.userId) {
        budgetPct.user = Math.max(budgetPct.user ?? 0, fraction);
      }
    }
    return budgetPct;
  }

  private async executeExactCacheRule<T>(
    request: ExactCacheRequest,
    providerCall: () => Promise<T>,
    context: ExactCacheContext,
    rule: EnforcementRule,
  ): Promise<T> {
    if (request.stream === true || cacheBypassed(context)) {
      this.exactCacheBypasses++;
      return providerCall();
    }

    const key = exactCacheKey(this.apiKey, rule.id, request);
    const cached = this.getExactCache(key);
    if (cached) {
      this.exactCacheHits++;
      this.exactCacheSavingsUsdMicros += cached.costBasis.savingsUsdMicros;
      this.trackDecision(this.postExactCacheDecision(rule, request.model, cached.costBasis));
      return cached.response as T;
    }
    this.exactCacheMisses++;
    this.trackDecision(this.postExactCacheMiss(rule, request.model));

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

  private async executeSemanticCacheRule<T>(
    request: ExactCacheRequest,
    providerCall: () => Promise<T>,
    context: RequestEnforcementContext,
    rule: EnforcementRule,
  ): Promise<T> {
    if (!this.semanticCacheConfig || request.stream === true || cacheBypassed(context)) {
      this.semanticCacheBypasses++;
      return providerCall();
    }

    const text = semanticCacheText(request, context);
    if (!text) {
      this.semanticCacheBypasses++;
      return providerCall();
    }
    const vector = await boundedEmbedding(this.semanticCacheConfig.embed, text, this.semanticCacheTimeoutMs);
    if (!vector) {
      this.semanticCacheEmbeddingFailures++;
      this.enforcementStats.failOpenRequests++;
      return providerCall();
    }

    const threshold = boundedSimilarityThreshold(rule.actionParams.similarityThreshold);
    const cached = this.getSemanticCache(rule.id, request.model, vector, threshold);
    if (cached.entry) {
      this.semanticCacheHits++;
      this.semanticCacheSavingsUsdMicros += cached.entry.costBasis.savingsUsdMicros;
      this.trackDecision(
        this.postSemanticCacheDecision(rule, request.model, "hit", cached.similarity, cached.entry.costBasis),
      );
      return cached.entry.response as T;
    }

    this.semanticCacheMisses++;
    this.trackDecision(this.postSemanticCacheDecision(rule, request.model, "miss", cached.similarity));
    const response = await providerCall();
    try {
      const key = semanticCacheKey(this.apiKey, rule.id, request.model, text);
      this.setSemanticCache(key, {
        ruleId: rule.id,
        requestedModel: request.model,
        vector,
        response,
        expiresAt: Date.now() + boundedTtlSeconds(rule.actionParams.cacheTtlSec) * 1000,
        costBasis: responseCostBasis(response, context.provider),
      });
    } catch {
      // A cache write/costing failure does not affect the provider response.
    }
    return response;
  }

  private async executeFallbackRule<T, R extends ExactCacheRequest>(
    request: R,
    providerCall: (effectiveRequest: R) => Promise<T>,
    context: RequestEnforcementContext,
    rule: EnforcementRule,
    fallbackModel: string,
    reason: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await providerCall(request);
    } catch (primaryError) {
      const fallbackRequest = { ...request, model: fallbackModel } as R;
      try {
        const response = await providerCall(fallbackRequest);
        this.trackDecision(
          this.postFallbackDecision(rule, request.model, fallbackModel, context.feature, "success", reason),
        );
        return response;
      } catch {
        this.trackDecision(
          this.postFallbackDecision(rule, request.model, fallbackModel, context.feature, "failed", reason),
        );
        throw primaryError;
      }
    }
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

  private getSemanticCache(
    ruleId: string,
    requestedModel: string,
    vector: number[],
    threshold: number,
  ): { entry?: SemanticCacheEntry; similarity: number | null } {
    let bestKey: string | null = null;
    let bestEntry: SemanticCacheEntry | undefined;
    let bestSimilarity = -1;
    for (const [key, entry] of this.semanticCache) {
      if (entry.expiresAt <= Date.now()) {
        this.semanticCache.delete(key);
        continue;
      }
      if (entry.ruleId !== ruleId || entry.requestedModel !== requestedModel || entry.vector.length !== vector.length) {
        continue;
      }
      const similarity = dotProduct(vector, entry.vector);
      if (similarity > bestSimilarity) {
        bestKey = key;
        bestEntry = entry;
        bestSimilarity = similarity;
      }
    }
    if (!bestEntry || !bestKey || bestSimilarity < threshold) {
      return { similarity: bestSimilarity >= 0 ? bestSimilarity : null };
    }
    this.semanticCache.delete(bestKey);
    this.semanticCache.set(bestKey, bestEntry);
    return { entry: bestEntry, similarity: bestSimilarity };
  }

  private setSemanticCache(key: string, entry: SemanticCacheEntry): void {
    this.semanticCache.delete(key);
    this.semanticCache.set(key, entry);
    while (this.semanticCache.size > this.semanticCacheMaxEntries) {
      const oldest = this.semanticCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.semanticCache.delete(oldest);
    }
  }

  private postExactCacheDecision(
    rule: EnforcementRule,
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

  private postExactCacheMiss(rule: EnforcementRule, requestedModel: string): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      cacheOutcome: "miss",
      requestedModel,
    });
  }

  private postSemanticCacheDecision(
    rule: EnforcementRule,
    requestedModel: string,
    cacheOutcome: "hit" | "miss",
    similarity: number | null,
    costBasis?: ExactCacheCostBasis,
  ): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      action: "CACHE_SEMANTIC",
      cacheOutcome,
      requestedModel,
      similarity,
      ...(costBasis
        ? {
            provider: costBasis.provider,
            servedModel: costBasis.model,
            inputTokens: costBasis.inputTokens,
            outputTokens: costBasis.outputTokens,
            cacheReadTokens: costBasis.cacheReadTokens,
            cacheWriteTokens: costBasis.cacheWriteTokens,
          }
        : {}),
    });
  }

  private postBlockingDecision(
    rule: EnforcementRule,
    requestedModel: string,
    action: BlockingRuleAction,
    retryCount: number | undefined,
    reason: Record<string, unknown>,
  ): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      action,
      requestedModel,
      retryCount: retryCount ?? 0,
      reason,
    });
  }

  private postModelDecision(
    rule: EnforcementRule,
    action: Exclude<ModelRuleAction, "FALLBACK">,
    requestedModel: string,
    servedModel: string,
    feature: string | undefined,
    experimentId: string,
    costBasis: ExactCacheCostBasis,
  ): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      action,
      requestedModel,
      servedModel,
      feature,
      experimentId,
      provider: costBasis.provider,
      inputTokens: costBasis.inputTokens,
      outputTokens: costBasis.outputTokens,
      cacheReadTokens: costBasis.cacheReadTokens,
      cacheWriteTokens: costBasis.cacheWriteTokens,
    });
  }

  private postFallbackDecision(
    rule: EnforcementRule,
    requestedModel: string,
    servedModel: string,
    feature: string | undefined,
    fallbackOutcome: "success" | "failed",
    reason: Record<string, unknown>,
  ): Promise<void> {
    return this.postJson(this.siblingEndpoint("decisions"), {
      ruleId: rule.id,
      action: "FALLBACK",
      requestedModel,
      servedModel,
      feature,
      fallbackOutcome,
      reason,
    });
  }

  private trackDecision(promise: Promise<void>): void {
    this.pendingDecisions.add(promise);
    promise.finally(() => this.pendingDecisions.delete(promise)).catch(() => {});
  }

  private async postJson(url: string, body: unknown): Promise<void> {
    this.enforcementStats.decisionPosts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.enforcementTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "X-Source": "traice-sdk",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`Decision upload failed with HTTP ${response.status}`), {
          status: response.status,
        });
      }
    } catch (error) {
      const status =
        typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : undefined;
      this.reportEnforcementFailure(asError(error), {
        operation: "decision_post",
        ...(status == null ? {} : { status }),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportEnforcementFailure(error: Error, context: EnforcementErrorContext): void {
    if (context.operation === "rules_refresh") this.enforcementStats.ruleRefreshFailures++;
    else if (context.operation === "policy_refresh") this.enforcementStats.policyRefreshFailures++;
    else this.enforcementStats.decisionPostFailures++;
    try {
      this.onEnforcementError?.(error, context);
    } catch {
      // An observer must never affect request-path behavior.
    }
  }

  private siblingEndpoint(resource: "rules" | "policy" | "decisions"): string {
    const url = new URL(this.endpoint);
    url.pathname = url.pathname.replace(/\/events\/?$/, `/${resource}`);
    return url.toString();
  }

  private flushBuffer(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    if (this.buffer.length === 0) return Promise.resolve();
    this.flushPromise = this.drainBuffer().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async drainBuffer(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      try {
        await this.sendBatch(batch);
        await this.persistDurableQueue();
      } catch (error) {
        this.deliveryStats.failedBatches++;
        this.deliveryStats.lastErrorAt = new Date().toISOString();
        if (error instanceof CloudDeliveryError && !error.retryable) {
          this.deliveryStats.rejected += batch.length;
          this.reportDeliveryError(error);
        } else {
          this.requeueFront(batch);
        }
        await this.persistDurableQueue();
        throw error;
      }
    }
  }

  private async sendBatch(batch: QueuedCostEvent[]): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxDeliveryAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "X-Source": "traice-sdk",
          },
          body: JSON.stringify({
            events: batch.map(({ event }) => toCloudEvent(event, { captureContent: this.captureContent })),
          }),
          signal: controller.signal,
        });
        if (response.ok) {
          const summary = deliverySummary(await response.json().catch(() => ({})), batch.length);
          this.deliveryStats.accepted += summary.accepted;
          this.deliveryStats.deduplicated += summary.deduplicated;
          this.deliveryStats.quotaDropped += summary.quotaDropped;
          this.deliveryStats.lastSuccessAt = new Date().toISOString();
          try {
            this.onDelivery?.(summary);
          } catch {
            // Delivery observers cannot affect telemetry.
          }
          return;
        }

        const body = await response.text().catch(() => "");
        const error = new CloudDeliveryError(
          `CloudAdapter failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`,
          isRetryableDeliveryStatus(response.status),
        );
        if (!error.retryable) throw error;
        lastError = error;
        if (attempt + 1 < this.maxDeliveryAttempts) {
          this.deliveryStats.retries++;
          await sleep(retryDelayMs(response, attempt, this.maxRetryDelayMs));
        }
      } catch (error) {
        if (error instanceof CloudDeliveryError && !error.retryable) throw error;
        lastError = asError(error);
        if (attempt + 1 < this.maxDeliveryAttempts) {
          this.deliveryStats.retries++;
          await sleep(jitteredBackoffMs(attempt, this.maxRetryDelayMs));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new CloudDeliveryError(lastError?.message ?? "CloudAdapter delivery failed", true);
  }

  private requeueFront(batch: QueuedCostEvent[]): void {
    const room = Math.max(0, this.maxQueueSize - this.buffer.length);
    const retained = batch.slice(Math.max(0, batch.length - room));
    const dropped = batch.length - retained.length;
    if (dropped > 0) {
      this.deliveryStats.queueDropped += dropped;
      this.reportDeliveryError(new Error(`CloudAdapter queue full; dropped ${dropped} failed delivery events`));
    }
    this.buffer.unshift(...retained);
  }

  private persistDurableQueue(): Promise<void> {
    return this.durableOutbox?.replace(this.buffer) ?? Promise.resolve();
  }

  private reportDeliveryError(error: Error): void {
    try {
      this.onDeliveryError?.(error);
    } catch {
      // Delivery observers cannot affect telemetry.
    }
  }
}

function isCacheRule(value: unknown): value is EnforcementRule {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Partial<EnforcementRule>;
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
    (rule.maxQualityDropPct == null || typeof rule.maxQualityDropPct === "number") &&
    Array.isArray(rule.modelAllowlist)
  );
}

function isEnforcementEvidence(value: unknown): value is EnforcementEvidence {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<EnforcementEvidence>;
  return (
    typeof evidence.experimentId === "string" &&
    typeof evidence.feature === "string" &&
    typeof evidence.sourceModel === "string" &&
    typeof evidence.candidateModel === "string" &&
    typeof evidence.equivalencePct === "number" &&
    Number.isFinite(evidence.equivalencePct) &&
    evidence.equivalencePct >= 0 &&
    evidence.equivalencePct <= 100 &&
    typeof evidence.sampleCount === "number" &&
    Number.isInteger(evidence.sampleCount) &&
    evidence.sampleCount >= 0
  );
}

function isEnforcementBudgetSnapshot(value: unknown): value is EnforcementBudgetSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const budget = value as Partial<EnforcementBudgetSnapshot>;
  return (
    (budget.scope === "WORKSPACE" || budget.scope === "FEATURE" || budget.scope === "USER") &&
    (budget.scopeValue === null || typeof budget.scopeValue === "string") &&
    typeof budget.pct === "number" &&
    Number.isFinite(budget.pct) &&
    budget.pct >= 0
  );
}

function mergeBudgetPct(
  cached: Partial<Record<"workspace" | "feature" | "user", number>>,
  override?: Partial<Record<"workspace" | "feature" | "user", number>>,
): Partial<Record<"workspace" | "feature" | "user", number>> {
  return { ...cached, ...override };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
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

function semanticCacheKey(apiKey: string, ruleId: string, requestedModel: string, text: string): string {
  const workspaceScope = crypto.createHash("sha256").update(apiKey).digest("hex");
  return crypto
    .createHash("sha256")
    .update(stableStringify({ workspaceScope, ruleId, requestedModel, text }))
    .digest("hex");
}

function semanticCacheText(request: ExactCacheRequest, context: RequestEnforcementContext): string | null {
  if (context.semanticCacheText !== undefined) return context.semanticCacheText.trim();
  try {
    return stableStringify(request);
  } catch {
    return null;
  }
}

async function boundedEmbedding(
  embed: SemanticCacheConfig["embed"],
  text: string,
  timeoutMs: number,
): Promise<number[] | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
    if (timeout.unref) timeout.unref();
  });
  const embedding = Promise.resolve()
    .then(() => embed(text))
    .then(normalizeEmbedding)
    .catch(() => null);
  try {
    return await Promise.race([embedding, timeoutResult]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeEmbedding(value: readonly number[]): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8192) return null;
  let magnitudeSquared = 0;
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    magnitudeSquared += item * item;
  }
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 0) return null;
  const magnitude = Math.sqrt(magnitudeSquared);
  return value.map((item) => item / magnitude);
}

function dotProduct(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index++) sum += left[index] * right[index];
  return Math.max(-1, Math.min(1, sum));
}

function boundedSimilarityThreshold(value: unknown): number {
  const threshold = Number(value);
  return Number.isFinite(threshold) ? Math.max(0.5, Math.min(1, threshold)) : 0.92;
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
      inputTokens?: unknown;
      outputTokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      inputTokenDetails?: { cacheReadTokens?: unknown; cacheWriteTokens?: unknown };
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
      : (value?.usage?.inputTokenDetails?.cacheReadTokens ??
          value?.usage?.input_tokens_details?.cached_tokens ??
          value?.usage?.prompt_tokens_details?.cached_tokens),
  );
  const cacheWrite = nonNegativeNumber(
    anthropic ? value?.usage?.cache_creation_input_tokens : value?.usage?.inputTokenDetails?.cacheWriteTokens,
  );
  const rawInput = nonNegativeNumber(
    anthropic
      ? value?.usage?.input_tokens
      : (value?.usage?.inputTokens ?? value?.usage?.input_tokens ?? value?.usage?.prompt_tokens),
  );
  const input = anthropic ? rawInput + cacheRead + cacheWrite : rawInput;
  const output = nonNegativeNumber(
    anthropic
      ? value?.usage?.output_tokens
      : (value?.usage?.outputTokens ?? value?.usage?.output_tokens ?? value?.usage?.completion_tokens),
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

export function toCloudEvent(event: CostEvent, options: { captureContent?: boolean } = {}): CloudCostEvent {
  return omitUndefined({
    source: "traice-sdk",
    externalId: event.id,
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
    prompt: options.captureContent ? event.prompt : undefined,
    output: options.captureContent ? event.output : undefined,
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

function deliverySummary(value: unknown, batchSize: number): CloudDeliverySummary {
  const body = value != null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const accepted = nonNegativeNumber(body.accepted ?? body.received ?? batchSize);
  const deduplicated = nonNegativeNumber(body.deduplicated);
  const quotaDropped = nonNegativeNumber(body.quotaDropped);
  const dropped = nonNegativeNumber(body.dropped ?? quotaDropped);
  const plan = typeof body.plan === "string" ? body.plan : undefined;
  return { accepted, deduplicated, quotaDropped, dropped, ...(plan ? { plan } : {}) };
}

function isRetryableDeliveryStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number, capMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(capMs, Math.max(0, seconds * 1000));
    const dateMs = new Date(retryAfter).getTime();
    if (Number.isFinite(dateMs)) return Math.min(capMs, Math.max(0, dateMs - Date.now()));
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetSeconds = resetHeader == null ? Number.NaN : Number(resetHeader);
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) {
    return Math.min(capMs, resetSeconds * 1000);
  }
  return jitteredBackoffMs(attempt, capMs);
}

function jitteredBackoffMs(attempt: number, capMs: number): number {
  const base = Math.min(capMs, 250 * 2 ** attempt);
  return Math.min(capMs, Math.max(0, Math.round(base * (0.5 + Math.random()))));
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
