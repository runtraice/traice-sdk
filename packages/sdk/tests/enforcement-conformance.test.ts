import fixtures from "./fixtures/enforcement-v2.json";
import { assignRollout, decide, type EnforcementRollout, type EnforcementRule } from "../src/enforcement";

describe("enforcement protocol v2 conformance", () => {
  it("keeps the shared protocol fixture on version 2", () => {
    expect(fixtures.protocolVersion).toBe(2);
  });

  it.each(fixtures.cases)("$name", (fixture) => {
    const evidence = new Map(
      fixture.evidence.map((candidate) => [
        candidate.candidateModel,
        { equivalencePct: candidate.equivalencePct, experimentId: candidate.experimentId },
      ]),
    );
    const originalOrder = fixture.rules.map((rule) => rule.id);
    const decision = decide(fixture.request, fixture.rules as EnforcementRule[], {
      equivalencePctFor: (candidateModel) => evidence.get(candidateModel)?.equivalencePct ?? null,
      experimentIdFor: (candidateModel) => evidence.get(candidateModel)?.experimentId ?? null,
    });

    expect(decision).toMatchObject(fixture.expected);
    expect(fixture.rules.map((rule) => rule.id)).toEqual(originalOrder);
  });

  it.each(fixtures.assignmentCases)("$name", ({ rollout, assignmentKey, expected }) => {
    expect(assignRollout(rollout as EnforcementRollout, assignmentKey)).toEqual(expected);
  });
});
