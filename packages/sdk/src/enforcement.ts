export type RuleAction =
  "SWAP" | "DOWNGRADE" | "CACHE_EXACT" | "CACHE_SEMANTIC" | "DENY" | "CAP_RETRIES" | "FALLBACK" | "ROUTE";

export type RuleState = "DRAFT" | "SHADOW" | "ACTIVE" | "DISABLED";
export type BudgetScope = "workspace" | "feature" | "user";

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
