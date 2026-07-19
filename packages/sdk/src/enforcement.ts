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
      evidence?: { requiredPct: number; actualPct: number | null; satisfied: boolean };
    };

const PASS_THROUGH: EnforcementDecision = {
  matched: false,
  action: "PASS_THROUGH",
  ruleId: null,
  reason: { type: "no_match" },
};

const ROUTING_ACTIONS: ReadonlySet<RuleAction> = new Set(["SWAP", "DOWNGRADE", "ROUTE"]);

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

    const isRouting = ROUTING_ACTIONS.has(rule.action);
    const targetModel = typeof rule.actionParams.targetModel === "string" ? rule.actionParams.targetModel : null;

    if (isRouting && targetModel && rule.modelAllowlist.length > 0 && !rule.modelAllowlist.includes(targetModel)) {
      continue;
    }

    const base = {
      matched: true as const,
      ruleId: rule.id,
      ruleName: rule.name,
      mode: rule.state === "ACTIVE" ? ("active" as const) : ("shadow" as const),
      action: rule.action,
      servedModel: isRouting ? targetModel : null,
    };

    if (isRouting && rule.requireEquivalencePct != null && targetModel) {
      const actualPct = context.equivalencePctFor?.(targetModel) ?? null;
      const satisfied = actualPct != null && actualPct >= rule.requireEquivalencePct;
      if (!satisfied) continue;
      return {
        ...base,
        reason: { ...match, targetModel },
        evidence: { requiredPct: rule.requireEquivalencePct, actualPct, satisfied },
      };
    }

    return {
      ...base,
      reason: targetModel ? { ...match, targetModel } : match,
    };
  }

  return PASS_THROUGH;
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
