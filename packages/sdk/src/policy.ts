import { DEFAULT_TRAICE_SERVER_URL, normalizeServerUrl } from "./ask";
import type { EnforcementRule } from "./enforcement";

type FetchLike = typeof fetch;

export type PortablePolicyEvidence = {
  experimentId: string;
  feature: string;
  sourceModel: string;
  candidateModel: string;
  equivalencePct: number;
  sampleCount: number;
};

export type PortablePolicyBudget = {
  scope: "WORKSPACE" | "FEATURE" | "USER";
  scopeValue: string | null;
  pct: number;
};

export type PortablePolicyBundle = {
  schemaVersion: "traice.policy.v1";
  generatedAt: string;
  enabled: boolean;
  ttlSeconds: number;
  rules: EnforcementRule[];
  evidence: PortablePolicyEvidence[];
  budgets: PortablePolicyBudget[];
};

export type ExportPolicyOptions = {
  apiKey: string;
  serverUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
};

/** Fetch a portable snapshot of the workspace's user-authored enforcement policy. */
export async function exportPolicy(options: ExportPolicyOptions): Promise<PortablePolicyBundle> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("trAIce API key is required");
  const serverUrl = normalizeServerUrl(options.serverUrl ?? DEFAULT_TRAICE_SERVER_URL);
  const response = await (options.fetchImpl ?? fetch)(`${serverUrl}/api/v1/rules`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const reason = stringValue(payload?.message) ?? stringValue(payload?.error) ?? `HTTP ${response.status}`;
    throw new Error(`trAIce policy export failed: ${reason}`);
  }
  if (!payload) throw new Error("trAIce policy export returned invalid JSON");

  const generatedAt = stringValue(payload.generatedAt);
  const ttlSeconds = numberValue(payload.ttlSeconds);
  if (
    !generatedAt ||
    Number.isNaN(new Date(generatedAt).getTime()) ||
    typeof payload.enabled !== "boolean" ||
    ttlSeconds == null ||
    ttlSeconds < 0 ||
    !Array.isArray(payload.rules) ||
    !Array.isArray(payload.evidence) ||
    !Array.isArray(payload.budgets) ||
    !payload.rules.every(isEnforcementRule) ||
    !payload.evidence.every(isEvidence) ||
    !payload.budgets.every(isBudget)
  ) {
    throw new Error("trAIce policy export returned an invalid policy bundle");
  }

  return {
    schemaVersion: "traice.policy.v1",
    generatedAt,
    enabled: payload.enabled,
    ttlSeconds,
    rules: payload.rules,
    evidence: payload.evidence,
    budgets: payload.budgets,
  };
}

function isEnforcementRule(value: unknown): value is EnforcementRule {
  if (!isObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.state === "DRAFT" || value.state === "SHADOW" || value.state === "ACTIVE" || value.state === "DISABLED") &&
    typeof value.priority === "number" &&
    Number.isFinite(value.priority) &&
    isRuleAction(value.action) &&
    isRuleCondition(value.condition) &&
    isObject(value.actionParams) &&
    Array.isArray(value.modelAllowlist) &&
    value.modelAllowlist.every((model) => typeof model === "string") &&
    (value.requireEquivalencePct == null || finiteNumber(value.requireEquivalencePct)) &&
    (value.maxQualityDropPct == null || finiteNumber(value.maxQualityDropPct))
  );
}

function isRuleAction(value: unknown): boolean {
  return (
    value === "SWAP" ||
    value === "DOWNGRADE" ||
    value === "CACHE_EXACT" ||
    value === "CACHE_SEMANTIC" ||
    value === "DENY" ||
    value === "CAP_RETRIES" ||
    value === "FALLBACK" ||
    value === "ROUTE"
  );
}

function isRuleCondition(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.type === "always") return true;
  if (value.type === "model" || value.type === "feature") return typeof value.equals === "string";
  if (value.type === "retry") return Number.isInteger(value.gte) && Number(value.gte) >= 0;
  return (
    value.type === "budget" &&
    (value.scope === "workspace" || value.scope === "feature" || value.scope === "user") &&
    finiteNumber(value.thresholdPct)
  );
}

function isEvidence(value: unknown): value is PortablePolicyEvidence {
  if (!isObject(value)) return false;
  return (
    typeof value.experimentId === "string" &&
    typeof value.feature === "string" &&
    typeof value.sourceModel === "string" &&
    typeof value.candidateModel === "string" &&
    finiteNumber(value.equivalencePct) &&
    value.equivalencePct >= 0 &&
    value.equivalencePct <= 100 &&
    Number.isInteger(value.sampleCount) &&
    Number(value.sampleCount) >= 0
  );
}

function isBudget(value: unknown): value is PortablePolicyBudget {
  if (!isObject(value)) return false;
  return (
    (value.scope === "WORKSPACE" || value.scope === "FEATURE" || value.scope === "USER") &&
    (value.scopeValue == null || typeof value.scopeValue === "string") &&
    finiteNumber(value.pct) &&
    value.pct >= 0
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numberValue(value: unknown): number | null {
  return finiteNumber(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
