import { detectTokenAbuse } from "../src/analytics/token-abuse";
import { CostEvent } from "../src/types";

function makeEvent(
  id: string,
  userId: string,
  tokens: number,
  cost: number,
  feature = "chat",
  tenantId = "tenant_acme",
): CostEvent {
  return {
    id,
    timestamp: "2026-06-30T10:00:00Z",
    provider: "openai",
    model: "gpt-4o-mini",
    inputTokens: Math.round(tokens * 0.8),
    outputTokens: Math.round(tokens * 0.2),
    totalTokens: tokens,
    inputCostUSD: cost * 0.4,
    outputCostUSD: cost * 0.6,
    totalCostUSD: cost,
    latencyMs: 400,
    feature,
    userId,
    tenantId,
  };
}

describe("detectTokenAbuse", () => {
  it("returns empty when there are no events", () => {
    expect(detectTokenAbuse([])).toEqual([]);
  });

  it("requires enough users for peer comparison", () => {
    const events = [makeEvent("e1", "user_a", 500_000, 5), makeEvent("e2", "user_b", 10_000, 0.1)];

    expect(detectTokenAbuse(events)).toEqual([]);
  });

  it("detects a user with disproportionate token volume", () => {
    const events = [
      makeEvent("abuse-1", "user_abuse", 450_000, 4.5, "customer-chatbot"),
      makeEvent("abuse-2", "user_abuse", 350_000, 3.5, "customer-chatbot"),
      makeEvent("normal-1", "user_a", 40_000, 0.4, "customer-chatbot"),
      makeEvent("normal-2", "user_b", 35_000, 0.35, "idea-generator"),
      makeEvent("normal-3", "user_c", 45_000, 0.45, "ai-monitor"),
    ];

    const results = detectTokenAbuse(events);

    expect(results).toHaveLength(1);
    expect(results[0].userId).toBe("user_abuse");
    expect(results[0].tokens).toBe(800_000);
    expect(results[0].workspaceTokenSharePct).toBeCloseTo(87, 1);
    expect(results[0].peerMultiple).toBe(18.8);
    expect(results[0].topFeature).toBe("customer-chatbot");
    expect(results[0].severity).toBe("high");
  });

  it("does not flag a top user when peer multiple is too low", () => {
    const events = [
      makeEvent("e1", "user_a", 220_000, 2.2),
      makeEvent("e2", "user_b", 180_000, 1.8),
      makeEvent("e3", "user_c", 160_000, 1.6),
      makeEvent("e4", "user_d", 150_000, 1.5),
    ];

    expect(detectTokenAbuse(events, { minWorkspaceSharePct: 25 })).toEqual([]);
  });

  it("respects custom thresholds", () => {
    const events = [
      makeEvent("e1", "user_abuse", 80_000, 0.8),
      makeEvent("e2", "user_a", 10_000, 0.1),
      makeEvent("e3", "user_b", 12_000, 0.12),
    ];

    expect(detectTokenAbuse(events)).toEqual([]);
    expect(detectTokenAbuse(events, { minTokens: 50_000, minPeerMultiple: 4 })).toHaveLength(1);
  });

  it("does not let undefined options disable defaults", () => {
    const events = [
      makeEvent("abuse-1", "user_abuse", 450_000, 4.5),
      makeEvent("abuse-2", "user_abuse", 350_000, 3.5),
      makeEvent("normal-1", "user_a", 40_000, 0.4),
      makeEvent("normal-2", "user_b", 35_000, 0.35),
      makeEvent("normal-3", "user_c", 45_000, 0.45),
    ];

    const optionsFromCli = {
      minUsers: undefined,
      minTokens: undefined,
      minCostUSD: undefined,
      minWorkspaceSharePct: undefined,
      minPeerMultiple: undefined,
      maxResults: undefined,
    };

    expect(detectTokenAbuse(events, optionsFromCli)).toHaveLength(1);
  });
});
