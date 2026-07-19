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
    expect(
      decide({ model: "gpt-4o" }, [guarded], { equivalencePctFor: () => 94, experimentIdFor: () => "experiment-1" }),
    ).toMatchObject({
      matched: true,
      action: "SWAP",
      servedModel: "gpt-4o-mini",
      evidence: { requiredPct: 90, actualPct: 94, satisfied: true, experimentId: "experiment-1" },
    });
  });

  it("selects an explicit allowlisted route only with passing evidence", () => {
    const routed = rule({
      action: "ROUTE",
      actionParams: { targetModel: "gpt-4o-mini" },
      requireEquivalencePct: 95,
      maxQualityDropPct: 5,
      modelAllowlist: ["gpt-4o-mini"],
    });

    expect(decide({ model: "gpt-4o", feature: "support" }, [routed])).toMatchObject({ matched: false });
    expect(
      decide({ model: "gpt-4o", feature: "support" }, [{ ...routed, modelAllowlist: [] }], {
        equivalencePctFor: () => 97,
        experimentIdFor: () => "experiment-route",
      }),
    ).toMatchObject({ matched: false });
    expect(
      decide({ model: "gpt-4o", feature: "support" }, [routed], {
        equivalencePctFor: () => 97,
      }),
    ).toMatchObject({ matched: false });
    expect(
      decide({ model: "gpt-4o", feature: "support" }, [routed], {
        equivalencePctFor: () => 97,
        experimentIdFor: () => "experiment-route",
      }),
    ).toMatchObject({
      matched: true,
      action: "ROUTE",
      servedModel: "gpt-4o-mini",
      evidence: { experimentId: "experiment-route", satisfied: true },
    });
  });

  it("scopes an experiment-derived model rule to its exact source model", () => {
    const guarded = rule({
      action: "SWAP",
      actionParams: { sourceModel: "gpt-4o", targetModel: "gpt-4o-mini" },
      requireEquivalencePct: 95,
      modelAllowlist: ["gpt-4o-mini"],
    });
    const evidence = { equivalencePctFor: () => 98, experimentIdFor: () => "experiment-1" };

    expect(decide({ model: "claude-3-5-sonnet", feature: "support" }, [guarded], evidence)).toMatchObject({
      matched: false,
    });
    expect(decide({ model: "gpt-4o", feature: "support" }, [guarded], evidence)).toMatchObject({
      matched: true,
      servedModel: "gpt-4o-mini",
      reason: expect.objectContaining({ sourceModel: "gpt-4o", targetModel: "gpt-4o-mini" }),
    });
  });

  it("honors the maximum allowed quality drop for model actions", () => {
    const guarded = rule({
      action: "DOWNGRADE",
      actionParams: { targetModel: "gpt-4o-mini" },
      requireEquivalencePct: 90,
      maxQualityDropPct: 5,
    });

    expect(decide({ model: "gpt-4o" }, [guarded], { equivalencePctFor: () => 94 })).toMatchObject({
      matched: false,
    });
    expect(decide({ model: "gpt-4o" }, [guarded], { equivalencePctFor: () => 96 })).toMatchObject({
      matched: true,
      evidence: { qualityDropPct: 4, maxQualityDropPct: 5 },
    });
  });

  it("requires a target model and honors the allowlist for fallback", () => {
    expect(decide({ model: "gpt-4o" }, [rule({ action: "FALLBACK" })])).toMatchObject({ matched: false });
    expect(
      decide({ model: "gpt-4o" }, [
        rule({
          action: "FALLBACK",
          actionParams: { targetModel: "gpt-4o-mini" },
          modelAllowlist: ["claude-3-5-haiku"],
        }),
      ]),
    ).toMatchObject({ matched: false });
    expect(
      decide({ model: "gpt-4o" }, [
        rule({
          action: "FALLBACK",
          actionParams: { targetModel: "gpt-4o-mini" },
          modelAllowlist: ["gpt-4o-mini"],
        }),
      ]),
    ).toMatchObject({ matched: true, action: "FALLBACK", servedModel: "gpt-4o-mini" });
  });

  it("selects a retry cap only after the configured retry allowance is exceeded", () => {
    const capped = rule({
      action: "CAP_RETRIES",
      actionParams: { maxRetries: 2 },
    });
    const fallback = rule({ id: "fallback", priority: 200 });

    expect(decide({ model: "gpt-4o-mini", retryCount: 2 }, [capped, fallback])).toMatchObject({
      ruleId: "fallback",
    });
    expect(decide({ model: "gpt-4o-mini", retryCount: 3 }, [capped, fallback])).toMatchObject({
      ruleId: "rule-1",
      action: "CAP_RETRIES",
    });
  });

  it("fails safe when a retry-cap rule has malformed action parameters", () => {
    const malformed = rule({ action: "CAP_RETRIES", actionParams: { maxRetries: "2" } });
    expect(decide({ model: "gpt-4o-mini", retryCount: 3 }, [malformed])).toMatchObject({ matched: false });
  });

  it("fails safe for an unknown persisted condition", () => {
    const candidate = rule({ condition: { type: "unknown" } as unknown as EnforcementRule["condition"] });
    expect(decide({ model: "gpt-4o-mini" }, [candidate])).toMatchObject({ matched: false });
  });
});
