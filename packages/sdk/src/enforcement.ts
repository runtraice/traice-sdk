export type RuleAction =
  | "SWAP"
  | "DOWNGRADE"
  | "CACHE_EXACT"
  | "CACHE_SEMANTIC"
  | "DENY"
  | "CAP_RETRIES"
  | "FALLBACK"
  | "ROUTE"
  | "RATE_LIMIT"
  | "LOAD_BALANCE";

export type RuleState = "DRAFT" | "SHADOW" | "ACTIVE" | "DISABLED";
export type BudgetScope = "workspace" | "feature" | "user";

export type EnforcementRollout = {
  id: string;
  workspaceId: string;
  status: "VERIFYING" | "RUNNING" | "PAUSED" | "ROLLED_BACK" | "COMPLETED";
  allocationBps: number;
  revision: number;
  assignmentSalt: string;
  assignmentUnit: "request" | "stable_key";
  sourceFallbackEnabled: boolean;
};

export type RolloutAssignment = { arm: "control" | "treatment"; bucket: number };

export function assignRollout(rollout: EnforcementRollout, assignmentKey: string): RolloutAssignment {
  const digest = createHash("sha256")
    .update(`${rollout.workspaceId}:${rollout.id}:${rollout.assignmentSalt}:${assignmentKey}`)
    .digest("hex");
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 10_000;
  const allocationBps =
    rollout.status === "VERIFYING" || rollout.status === "ROLLED_BACK"
      ? 0
      : rollout.status === "COMPLETED"
        ? 10_000
        : rollout.allocationBps;
  return { bucket, arm: bucket < allocationBps ? "treatment" : "control" };
}

export type RuleCondition =
  | { type: "always" }
  | { type: "budget"; scope: BudgetScope; thresholdPct: number }
  | { type: "model"; equals: string }
  | { type: "feature"; equals: string }
  | { type: "retry"; gte: number };

export interface EnforcementRule {
  id: string;
  name: string;
  state: RuleState;
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  actionParams: Record<string, unknown>;
  requireEquivalencePct: number | null;
  modelAllowlist: string[];
  maxQualityDropPct?: number | null;
  rollout?: EnforcementRollout;
}

export interface EnforcementRequest {
  model: string;
  feature?: string | null;
  retryCount?: number;
}

export interface EnforcementContext {
  /** Current-period spend as a fraction from 0 to 1 by budget scope. */
  budgetPct?: Partial<Record<BudgetScope, number>>;
  /** Proven equivalence percentage for the candidate model, or null when no evidence exists. */
  equivalencePctFor?: (candidateModel: string) => number | null;
  /** Experiment identifier backing the supplied equivalence percentage. */
  experimentIdFor?: (candidateModel: string) => string | null;
}

export type EnforcementDecision =
  | {
      matched: false;
      action: "PASS_THROUGH";
      ruleId: null;
      reason: { type: "no_match" };
    }
  | {
      matched: true;
      ruleId: string;
      ruleName: string;
      mode: "active" | "shadow";
      action: RuleAction;
      servedModel: string | null;
      rollout?: EnforcementRollout;
      reason: Record<string, unknown>;
      evidence?: {
        requiredPct: number;
        actualPct: number | null;
        satisfied: boolean;
        experimentId?: string;
        qualityDropPct?: number;
        maxQualityDropPct?: number;
      };
    };

const PASS_THROUGH: EnforcementDecision = {
  matched: false,
  action: "PASS_THROUGH",
  ruleId: null,
  reason: { type: "no_match" },
};

const TARGETED_ACTIONS: ReadonlySet<RuleAction> = new Set(["SWAP", "DOWNGRADE", "FALLBACK", "ROUTE"]);
const EVIDENCE_ACTIONS: ReadonlySet<RuleAction> = new Set(["SWAP", "DOWNGRADE", "ROUTE"]);

/**
 * Select the first enforceable rule for a request without performing I/O.
 *
 * Rules are evaluated in ascending priority order. DRAFT and DISABLED rules
 * are ignored. Unknown conditions fail safe by not matching. Routing actions
 * whose allowlist or equivalence guard is not satisfied are skipped so a later
 * valid rule can match.
 */
export function decide(
  request: EnforcementRequest,
  rules: readonly EnforcementRule[],
  context: EnforcementContext = {},
): EnforcementDecision {
  const ordered = rules
    .filter((rule) => rule.state === "ACTIVE" || rule.state === "SHADOW")
    .slice()
    .sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    // Rate limits are counted by trAIce (matchRateLimitRules) and never stop
    // evaluation, so a limit under its ceiling cannot hide a later rule.
    if (rule.action === "RATE_LIMIT") continue;
    // Load balancing picks a provider key for whatever model the other rules
    // choose (matchLoadBalanceRule), so it never stops evaluation either.
    if (rule.action === "LOAD_BALANCE") continue;
    const match = matchCondition(rule.condition, request, context);
    if (!match) continue;

    const isTargeted = TARGETED_ACTIONS.has(rule.action);
    const requiresEvidence = EVIDENCE_ACTIONS.has(rule.action);
    const targetModel = typeof rule.actionParams.targetModel === "string" ? rule.actionParams.targetModel : null;
    const sourceModel = typeof rule.actionParams.sourceModel === "string" ? rule.actionParams.sourceModel : null;

    if (rule.action === "CAP_RETRIES") {
      const maxRetries = nonNegativeInteger(rule.actionParams.maxRetries);
      const retryCount = request.retryCount ?? 0;
      if (maxRetries == null || retryCount <= maxRetries) continue;
    }

    if (isTargeted && !targetModel) continue;

    // Rules created from a validated experiment are scoped to the exact source
    // model that was replayed. A different source model must never inherit that
    // experiment merely because the feature and candidate also have evidence.
    if (isTargeted && sourceModel && request.model !== sourceModel) continue;

    if (rule.action === "ROUTE" && (!targetModel || rule.modelAllowlist.length === 0)) {
      continue;
    }

    if (isTargeted && targetModel && rule.modelAllowlist.length > 0 && !rule.modelAllowlist.includes(targetModel)) {
      continue;
    }

    if (rule.action === "ROUTE" && rule.requireEquivalencePct == null) continue;

    const base = {
      matched: true as const,
      ruleId: rule.id,
      ruleName: rule.name,
      mode: rule.state === "ACTIVE" ? ("active" as const) : ("shadow" as const),
      action: rule.action,
      servedModel: isTargeted ? targetModel : null,
      ...(rule.rollout ? { rollout: rule.rollout } : {}),
    };

    if (requiresEvidence && rule.requireEquivalencePct != null && targetModel) {
      const actualPct = context.equivalencePctFor?.(targetModel) ?? null;
      const qualityDropPct = actualPct == null ? null : Math.max(0, 100 - actualPct);
      const qualitySatisfied =
        rule.maxQualityDropPct == null || (qualityDropPct != null && qualityDropPct <= rule.maxQualityDropPct);
      const satisfied = actualPct != null && actualPct >= rule.requireEquivalencePct && qualitySatisfied;
      if (!satisfied) continue;
      const experimentId = context.experimentIdFor?.(targetModel) ?? undefined;
      if (rule.action === "ROUTE" && !experimentId) continue;
      return {
        ...base,
        reason: { ...match, ...(sourceModel ? { sourceModel } : {}), targetModel },
        evidence: {
          requiredPct: rule.requireEquivalencePct,
          actualPct,
          satisfied,
          ...(experimentId ? { experimentId } : {}),
          ...(qualityDropPct != null ? { qualityDropPct } : {}),
          ...(rule.maxQualityDropPct != null ? { maxQualityDropPct: rule.maxQualityDropPct } : {}),
        },
      };
    }

    return {
      ...base,
      reason: targetModel ? { ...match, ...(sourceModel ? { sourceModel } : {}), targetModel } : match,
    };
  }

  return PASS_THROUGH;
}

/** Who shares one rate-limit counter: the whole workspace, each API key, or each end user. */
export type RateLimitPer = "workspace" | "api_key" | "user";
const RATE_LIMIT_PER: readonly RateLimitPer[] = ["workspace", "api_key", "user"];

export interface RateLimitMatch {
  ruleId: string;
  ruleName: string;
  mode: "active" | "shadow";
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
  per: RateLimitPer;
}

/**
 * Rate-limit rules that apply to a request, by ascending priority. Every
 * matching rule is returned: trAIce counts the request against each one, so a
 * limit holds across instances, and only an active rule over its limit
 * refuses it. Only `always`, `model` and `feature` conditions apply; a rule
 * without a valid limit or with an unknown `per` is ignored.
 */
export function matchRateLimitRules(req: EnforcementRequest, rules: EnforcementRule[]): RateLimitMatch[] {
  return rules
    .filter((rule) => rule.action === "RATE_LIMIT" && (rule.state === "ACTIVE" || rule.state === "SHADOW"))
    .sort((a, b) => a.priority - b.priority)
    .flatMap((rule): RateLimitMatch[] => {
      const type = rule.condition?.type;
      if (type !== "always" && type !== "model" && type !== "feature") return [];
      if (!matchCondition(rule.condition, req, {})) return [];
      const requestsPerMinute = positiveInteger(rule.actionParams.requestsPerMinute);
      const tokensPerMinute = positiveInteger(rule.actionParams.tokensPerMinute);
      if (requestsPerMinute == null && tokensPerMinute == null) return [];
      const per = rule.actionParams.per ?? "workspace";
      if (!RATE_LIMIT_PER.includes(per as RateLimitPer)) return [];
      return [
        {
          ruleId: rule.id,
          ruleName: rule.name,
          mode: rule.state === "ACTIVE" ? "active" : "shadow",
          requestsPerMinute,
          tokensPerMinute,
          per: per as RateLimitPer,
        },
      ];
    });
}

/**
 * Strict budget caps (enforcement protocol v4). `GET /api/v1/rules` lists the
 * strictly capped budget scopes that are close to their limit for this key.
 * Before a call, the SDK finds the entries that apply to the request and asks
 * trAIce to check them; it never decides a strict cap on its own.
 */
export const STRICT_CAP_SCOPES = ["workspace", "feature", "user", "api_key", "team"] as const;
export type StrictCapScope = (typeof STRICT_CAP_SCOPES)[number];
export type StrictCapOnUnavailable = "allow" | "block";

export type StrictCapEntry = {
  ruleId: string;
  mode: "active" | "shadow";
  /** workspace, api_key and team apply to every call from this key; feature and user to matching calls. */
  scope: StrictCapScope;
  value: string | null;
  onUnavailable: StrictCapOnUnavailable;
};

export type StrictCapRequest = { feature?: string | null; userId?: string | null };

export type StrictCapMatch = {
  ruleId: string;
  mode: "active" | "shadow";
  /** What to do when trAIce does not answer: block if any matching active entry says so. */
  onUnavailable: StrictCapOnUnavailable;
};

function strictCapEntryApplies(entry: StrictCapEntry, req: StrictCapRequest): boolean {
  if (entry.scope === "feature") return entry.value != null && req.feature === entry.value;
  if (entry.scope === "user") return entry.value != null && req.userId === entry.value;
  return STRICT_CAP_SCOPES.includes(entry.scope);
}

/** The strict caps a request must be checked against, one per rule, in the order received. */
export function matchStrictCaps(req: StrictCapRequest, entries: readonly StrictCapEntry[]): StrictCapMatch[] {
  const byRule = new Map<string, StrictCapMatch>();
  for (const entry of entries) {
    if (!entry || typeof entry.ruleId !== "string" || !strictCapEntryApplies(entry, req)) continue;
    const mode = entry.mode === "active" ? "active" : "shadow";
    const onUnavailable = mode === "active" && entry.onUnavailable === "block" ? "block" : "allow";
    const existing = byRule.get(entry.ruleId);
    if (!existing) {
      byRule.set(entry.ruleId, { ruleId: entry.ruleId, mode, onUnavailable });
    } else if (onUnavailable === "block") {
      existing.onUnavailable = "block";
    }
  }
  return Array.from(byRule.values());
}

/**
 * Load balancing across provider keys (LOAD_BALANCE rules, enforcement
 * protocol v5).
 *
 * Pure and deterministic: the caller supplies the random number and the clock.
 * Provider keys never reach trAIce. A rule names key aliases the customer
 * chose; the SDK picks one per call and hands it to the customer's provider
 * callback, which maps the alias to a real client or key.
 */
export const LOAD_BALANCE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
export const LOAD_BALANCE_MIN_KEYS = 2;
export const LOAD_BALANCE_MAX_KEYS = 10;
export const LOAD_BALANCE_MAX_WEIGHT = 100;
export const LOAD_BALANCE_MIN_COOLDOWN_MS = 1_000;
export const LOAD_BALANCE_MAX_COOLDOWN_MS = 600_000;
export const LOAD_BALANCE_DEFAULT_COOLDOWN_MS = 60_000;

/** What to do when the provider rate-limits (HTTP 429) the key a call used. */
export type LoadBalanceOnRateLimit = "next_key" | "none";
export const LOAD_BALANCE_ON_RATE_LIMIT: readonly LoadBalanceOnRateLimit[] = ["next_key", "none"];

export type LoadBalanceKey = { alias: string; weight: number };

export type LoadBalanceParams = {
  keys: LoadBalanceKey[];
  onRateLimit: LoadBalanceOnRateLimit;
  cooldownMs: number;
};

/**
 * A stored rule's keys and settings, or null when they are not usable: fewer
 * than two keys, more than ten, an alias outside the pattern, a repeated
 * alias, or a weight outside 1 to 100. Unknown settings fall back to defaults.
 */
export function loadBalanceParams(actionParams: unknown): LoadBalanceParams | null {
  if (!actionParams || typeof actionParams !== "object" || Array.isArray(actionParams)) return null;
  const params = actionParams as Record<string, unknown>;
  if (!Array.isArray(params.keys)) return null;
  const keys: LoadBalanceKey[] = [];
  const seen = new Set<string>();
  for (const entry of params.keys) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { alias, weight } = entry as Record<string, unknown>;
    if (typeof alias !== "string" || !LOAD_BALANCE_ALIAS_PATTERN.test(alias) || seen.has(alias)) return null;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1 || weight > LOAD_BALANCE_MAX_WEIGHT) {
      return null;
    }
    seen.add(alias);
    keys.push({ alias, weight });
  }
  if (keys.length < LOAD_BALANCE_MIN_KEYS || keys.length > LOAD_BALANCE_MAX_KEYS) return null;
  const onRateLimit = LOAD_BALANCE_ON_RATE_LIMIT.includes(params.onRateLimit as LoadBalanceOnRateLimit)
    ? (params.onRateLimit as LoadBalanceOnRateLimit)
    : "next_key";
  const cooldown = params.cooldownMs;
  const cooldownMs =
    typeof cooldown === "number" &&
    Number.isInteger(cooldown) &&
    cooldown >= LOAD_BALANCE_MIN_COOLDOWN_MS &&
    cooldown <= LOAD_BALANCE_MAX_COOLDOWN_MS
      ? cooldown
      : LOAD_BALANCE_DEFAULT_COOLDOWN_MS;
  return { keys, onRateLimit, cooldownMs };
}

export type LoadBalancePickInput = {
  /** A number in [0, 1); the SDK passes Math.random(). */
  random: number;
  /** Epoch milliseconds. */
  now: number;
  /** When each alias may be used again after a provider rate limit (epoch ms). */
  coolingUntil?: Record<string, number>;
  /** Aliases already tried for this call. */
  exclude?: readonly string[];
};

/**
 * The key alias for one call: a weighted pick among keys that are not cooling
 * down after a rate limit, in the rule's order. When every remaining key is
 * cooling down, the one that becomes available first (earliest in the rule on
 * a tie). Null when every key was already tried.
 */
export function pickLoadBalanceKey(keys: readonly LoadBalanceKey[], input: LoadBalancePickInput): string | null {
  const excluded = new Set(input.exclude ?? []);
  const candidates = keys.filter((key) => !excluded.has(key.alias));
  if (candidates.length === 0) return null;
  const coolingUntil = input.coolingUntil ?? {};
  const available = candidates.filter((key) => (coolingUntil[key.alias] ?? 0) <= input.now);
  if (available.length === 0) {
    let soonest = candidates[0]!;
    for (const key of candidates) {
      if ((coolingUntil[key.alias] ?? 0) < (coolingUntil[soonest.alias] ?? 0)) soonest = key;
    }
    return soonest.alias;
  }
  const total = available.reduce((sum, key) => sum + key.weight, 0);
  const random = Number.isFinite(input.random) ? Math.min(Math.max(input.random, 0), 1 - Number.EPSILON) : 0;
  let target = random * total;
  for (const key of available) {
    if (target < key.weight) return key.alias;
    target -= key.weight;
  }
  return available[available.length - 1]!.alias;
}

export type LoadBalanceMatch = LoadBalanceParams & {
  ruleId: string;
  ruleName: string;
  mode: "active" | "shadow";
};

/**
 * The load-balancing rule that applies to a request: the first matching
 * ACTIVE or SHADOW rule by ascending priority, or null. Only `always`, `model`
 * and `feature` conditions apply. A rule whose keys are not usable is skipped,
 * so the next matching rule (or none) applies.
 */
export function matchLoadBalanceRule(req: EnforcementRequest, rules: EnforcementRule[]): LoadBalanceMatch | null {
  const ordered = rules
    .filter((rule) => rule.action === "LOAD_BALANCE" && (rule.state === "ACTIVE" || rule.state === "SHADOW"))
    .sort((a, b) => a.priority - b.priority);
  for (const rule of ordered) {
    const type = rule.condition?.type;
    if (type !== "always" && type !== "model" && type !== "feature") continue;
    if (!matchCondition(rule.condition, req, {})) continue;
    const params = loadBalanceParams(rule.actionParams);
    if (!params) continue;
    return { ruleId: rule.id, ruleName: rule.name, mode: rule.state === "ACTIVE" ? "active" : "shadow", ...params };
  }
  return null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function matchCondition(
  condition: RuleCondition,
  request: EnforcementRequest,
  context: EnforcementContext,
): Record<string, unknown> | null {
  switch (condition.type) {
    case "always":
      return { type: "always" };
    case "model":
      return request.model === condition.equals ? { type: "model", model: request.model } : null;
    case "feature":
      return (request.feature ?? null) === condition.equals ? { type: "feature", feature: condition.equals } : null;
    case "retry": {
      const retryCount = request.retryCount ?? 0;
      return retryCount >= condition.gte ? { type: "retry", retryCount, gte: condition.gte } : null;
    }
    case "budget": {
      const budgetPct = context.budgetPct?.[condition.scope];
      if (budgetPct == null) return null;
      const spentPct = Math.round(budgetPct * 100);
      return spentPct >= condition.thresholdPct
        ? { type: "budget", scope: condition.scope, spentPct, thresholdPct: condition.thresholdPct }
        : null;
    }
    default:
      return null;
  }
}
import { createHash } from "node:crypto";
