import { CostAdapter, CostEvent, EventMetadata } from "../types";
import { calculateCost } from "../pricing";
import { decide, type EnforcementRule } from "../enforcement";
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
  /** Reports enforcement control-plane failures without changing fail-open behavior. */
  onEnforcementError?: (error: Error, context: EnforcementErrorContext) => void;
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
}

export type RequestEnforcementContext = ExactCacheContext;

export type EnforcementErrorContext = {
  operation: "rules_refresh" | "decision_post";
  status?: number;
};

export type EnforcementStats = {
  ruleRefreshes: number;
  ruleRefreshFailures: number;
  decisionPosts: number;
  decisionPostFailures: number;
  failOpenRequests: number;
};

export type BlockingRuleAction = "DENY" | "CAP_RETRIES";
export type ModelRuleAction = "SWAP" | "DOWNGRADE" | "FALLBACK";

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

type EnforcementBudgetSnapshot = {
  scope: "WORKSPACE" | "FEATURE" | "USER";
  scopeValue: string | null;
  pct: number;
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
  private onEnforcementError?: CloudAdapterConfig["onEnforcementError"];
  private rules: EnforcementRule[] = [];
  private evidence: EnforcementEvidence[] = [];
  private budgets: EnforcementBudgetSnapshot[] = [];
  private enforcementEnabled = true;
  private rulesFetchedAt = 0;
  private rulesTtlMs = 60_000;
  private rulesRefresh: Promise<boolean> | null = null;
  private pendingDecisions = new Set<Promise<void>>();
  private exactCacheHits = 0;
  private exactCacheMisses = 0;
  private exactCacheBypasses = 0;
  private exactCacheSavingsUsdMicros = 0;
  private enforcementStats: EnforcementStats = {
    ruleRefreshes: 0,
    ruleRefreshFailures: 0,
    decisionPosts: 0,
    decisionPostFailures: 0,
    failOpenRequests: 0,
  };

  constructor(config: CloudAdapterConfig) {
    this.apiKey = config.apiKey;
    this.endpoint = config.endpoint ?? "https://runtraice.com/api/v1/events";
    this.batchSize = config.batchSize ?? 50;
    this.exactCacheMaxEntries = Math.max(1, Math.floor(config.exactCacheMaxEntries ?? 1000));
    this.enforcementTimeoutMs = Math.max(100, Math.floor(config.enforcementTimeoutMs ?? 2000));
    this.onEnforcementError = config.onEnforcementError;
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

  /** Fetch and cache the current rules and experiment evidence before serving traffic. */
  async warmEnforcement(): Promise<boolean> {
    return this.refreshRules();
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
   * Active exact-cache rules may return a cached response. Active deny and
   * retry-cap rules throw a structured TraiceEnforcementError. Active swap and
   * downgrade rules rewrite the model only with passing experiment evidence.
   * Active fallback rules make at most one configured fallback call after a
   * provider error. Shadow, unsupported, unavailable, or malformed rules pass
   * through unchanged.
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

    if (decision.action === "SWAP" || decision.action === "DOWNGRADE") {
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
    else this.enforcementStats.decisionPostFailures++;
    try {
      this.onEnforcementError?.(error, context);
    } catch {
      // An observer must never affect request-path behavior.
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
        throw new Error(`CloudAdapter failed: ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
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
