import fixtures from "./fixtures/rate-limit-v1.json";
import { decide, matchRateLimitRules, type EnforcementRule } from "../src/enforcement";

describe("rate-limit protocol v3 conformance", () => {
  it("keeps the rate-limit fixture on protocol version 3", () => {
    expect(fixtures.protocolVersion).toBe(3);
  });

  it.each(fixtures.cases)("$name", (fixture) => {
    const rules = fixture.rules as EnforcementRule[];
    const originalOrder = rules.map((rule) => rule.id);
    expect(matchRateLimitRules(fixture.request, rules)).toEqual(fixture.expectedLimits);
    expect(decide(fixture.request, rules)).toMatchObject(fixture.expectedDecision);
    expect(rules.map((rule) => rule.id)).toEqual(originalOrder);
  });
});
