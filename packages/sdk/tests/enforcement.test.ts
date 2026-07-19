import { decide, type EnforcementRule } from "../src/enforcement";

function rule(overrides: Partial<EnforcementRule> = {}): EnforcementRule {
  return {
    id: "rule-1",
    name: "Test rule",
    state: "ACTIVE",
    priority: 100,
    condition: { type: "always" },
    action: "CACHE_EXACT",
    actionParams: {},
    requireEquivalencePct: null,
    modelAllowlist: [],
    ...overrides,
  };
}

describe("decide", () => {
  it("returns pass-through when no rule matches", () => {
    expect(
      decide({ model: "gpt-4o-mini" }, [rule({ condition: { type: "model", equals: "claude-3-5-sonnet" } })]),
    ).toEqual({ matched: false, action: "PASS_THROUGH", ruleId: null, reason: { type: "no_match" } });
  });

  it("ignores draft and disabled rules and preserves shadow mode", () => {
    const decision = decide({ model: "gpt-4o-mini" }, [
      rule({ id: "draft", priority: 1, state: "DRAFT" }),
      rule({ id: "disabled", priority: 2, state: "DISABLED" }),
      rule({ id: "shadow", priority: 3, state: "SHADOW" }),
    ]);

    expect(decision).toMatchObject({ matched: true, ruleId: "shadow", mode: "shadow", action: "CACHE_EXACT" });
  });

  it("selects the lowest-priority-number matching rule without mutating the ruleset", () => {
    const rules = [rule({ id: "later", priority: 20 }), rule({ id: "first", priority: 10 })];

    expect(decide({ model: "gpt-4o-mini" }, rules)).toMatchObject({ matched: true, ruleId: "first" });
    expect(rules.map((candidate) => candidate.id)).toEqual(["later", "first"]);
  });

  it.each([
    [rule({ condition: { type: "model", equals: "gpt-4o-mini" } }), { model: "gpt-4o-mini" }],
    [rule({ condition: { type: "feature", equals: "support" } }), { model: "gpt-4o-mini", feature: "support" }],
    [rule({ condition: { type: "retry", gte: 2 } }), { model: "gpt-4o-mini", retryCount: 2 }],
  ])("matches supported request conditions", (candidate, request) => {
    expect(decide(request, [candidate])).toMatchObject({ matched: true, ruleId: "rule-1" });
  });

  it("matches a budget condition only when that scope is supplied and over threshold", () => {
    const candidate = rule({ condition: { type: "budget", scope: "feature", thresholdPct: 80 } });

    expect(decide({ model: "gpt-4o-mini" }, [candidate])).toMatchObject({ matched: false });
    expect(decide({ model: "gpt-4o-mini" }, [candidate], { budgetPct: { feature: 0.79 } })).toMatchObject({
      matched: false,
    });
    expect(decide({ model: "gpt-4o-mini" }, [candidate], { budgetPct: { feature: 0.8 } })).toMatchObject({
      matched: true,
      reason: { type: "budget", scope: "feature", spentPct: 80, thresholdPct: 80 },
    });
  });

  it("skips a routing rule whose target is outside its allowlist", () => {
    const blocked = rule({
      id: "blocked",
      priority: 1,
      action: "DOWNGRADE",
      actionParams: { targetModel: "gpt-4o-mini" },
      modelAllowlist: ["claude-3-5-haiku"],
    });
    const fallback = rule({ id: "fallback", priority: 2 });

    expect(decide({ model: "gpt-4o" }, [blocked, fallback])).toMatchObject({ ruleId: "fallback" });
  });

  it("requires affirmative equivalence evidence before selecting a guarded swap", () => {
    const guarded = rule({
      action: "SWAP",
      actionParams: { targetModel: "gpt-4o-mini" },
      requireEquivalencePct: 90,
      modelAllowlist: ["gpt-4o-mini"],
    });

    expect(decide({ model: "gpt-4o" }, [guarded])).toMatchObject({ matched: false });
    expect(decide({ model: "gpt-4o" }, [guarded], { equivalencePctFor: () => 89.9 })).toMatchObject({ matched: false });
    expect(decide({ model: "gpt-4o" }, [guarded], { equivalencePctFor: () => 94 })).toMatchObject({
      matched: true,
      action: "SWAP",
      servedModel: "gpt-4o-mini",
      evidence: { requiredPct: 90, actualPct: 94, satisfied: true },
    });
  });

  it("fails safe for an unknown persisted condition", () => {
    const candidate = rule({ condition: { type: "unknown" } as unknown as EnforcementRule["condition"] });
    expect(decide({ model: "gpt-4o-mini" }, [candidate])).toMatchObject({ matched: false });
  });
});
