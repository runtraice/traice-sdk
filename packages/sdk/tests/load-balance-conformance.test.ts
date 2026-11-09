import fixtures from "./fixtures/load-balance-v1.json";
import {
  decide,
  matchLoadBalanceRule,
  pickLoadBalanceKey,
  type EnforcementRule,
  type LoadBalanceKey,
  type LoadBalancePickInput,
} from "../src/enforcement";

describe("load-balance protocol v5 conformance", () => {
  it("keeps the load-balance fixture on protocol version 5", () => {
    expect(fixtures.protocolVersion).toBe(5);
  });

  it.each(fixtures.matchCases)("$name", (fixture) => {
    const rules = fixture.rules as EnforcementRule[];
    const originalOrder = rules.map((rule) => rule.id);
    expect(matchLoadBalanceRule(fixture.request, rules)).toEqual(fixture.expectedMatch);
    expect(decide(fixture.request, rules)).toMatchObject(fixture.expectedDecision);
    expect(rules.map((rule) => rule.id)).toEqual(originalOrder);
  });

  it.each(fixtures.pickCases)("picks a key: $name", (fixture) => {
    expect(pickLoadBalanceKey(fixture.keys as LoadBalanceKey[], fixture.input as LoadBalancePickInput)).toBe(
      fixture.expected,
    );
  });

  it("spreads calls in proportion to the weights", () => {
    const keys = fixtures.pickCases[0].keys as LoadBalanceKey[];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i += 1) {
      const alias = pickLoadBalanceKey(keys, { random: i / 1000, now: 0 }) as string;
      counts[alias] = (counts[alias] ?? 0) + 1;
    }
    expect(counts).toEqual({ primary: 500, secondary: 300, overflow: 200 });
  });
});
