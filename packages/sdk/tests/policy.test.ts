import { exportPolicy } from "../src/policy";

describe("portable policy export", () => {
  it("fetches and validates a portable policy without exposing the API key", async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://www.runtraice.com/api/v1/rules");
      expect(init?.headers).toEqual({
        authorization: "Bearer workspace-secret",
        accept: "application/json",
        "x-traice-enforcement-version": "2",
      });
      return Response.json({
        generatedAt: "2026-07-19T23:00:00.000Z",
        enabled: true,
        ttlSeconds: 60,
        rules: [
          {
            id: "rule-1",
            name: "Downgrade support",
            state: "ACTIVE",
            priority: 10,
            condition: { type: "feature", equals: "support" },
            action: "DOWNGRADE",
            actionParams: { targetModel: "gpt-4o-mini" },
            requireEquivalencePct: 95,
            modelAllowlist: ["gpt-4o-mini"],
          },
        ],
        evidence: [
          {
            experimentId: "experiment-1",
            feature: "support",
            sourceModel: "gpt-4o",
            candidateModel: "gpt-4o-mini",
            equivalencePct: 97,
            sampleCount: 50,
          },
        ],
        budgets: [{ scope: "FEATURE", scopeValue: "support", pct: 70 }],
      });
    });

    const result = await exportPolicy({ apiKey: "workspace-secret", fetchImpl: fetchMock as typeof fetch });

    expect(result).toMatchObject({ schemaVersion: "traice.policy.v1", enabled: true, ttlSeconds: 60 });
    expect(result.rules).toHaveLength(1);
    expect(result.evidence).toHaveLength(1);
    expect(result.budgets).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("workspace-secret");
  });

  it("reports authenticated API errors", async () => {
    const fetchMock = jest.fn(async () => Response.json({ error: "invalid_api_key" }, { status: 401 }));
    await expect(exportPolicy({ apiKey: "bad-key", fetchImpl: fetchMock as typeof fetch })).rejects.toThrow(
      "invalid_api_key",
    );
  });

  it("rejects malformed bundles instead of silently exporting them", async () => {
    const fetchMock = jest.fn(async () => Response.json({ enabled: true, rules: [] }));
    await expect(exportPolicy({ apiKey: "workspace-key", fetchImpl: fetchMock as typeof fetch })).rejects.toThrow(
      "invalid policy bundle",
    );
  });

  it("validates rollout policy fields", async () => {
    const bundle = {
      generatedAt: "2026-08-04T12:00:00.000Z",
      enabled: true,
      ttlSeconds: 60,
      rules: [
        {
          id: "rule-1",
          name: "Canary",
          state: "ACTIVE",
          priority: 10,
          condition: { type: "always" },
          action: "DOWNGRADE",
          actionParams: { targetModel: "gpt-4o-mini" },
          requireEquivalencePct: 95,
          modelAllowlist: ["gpt-4o-mini"],
          rollout: {
            id: "rollout-1",
            status: "RUNNING",
            allocationBps: 500,
            revision: 1,
            assignmentSalt: "test-salt",
            assignmentUnit: "request",
            sourceFallbackEnabled: true,
          },
        },
      ],
      evidence: [],
      budgets: [],
    };

    await expect(
      exportPolicy({
        apiKey: "workspace-key",
        fetchImpl: (async () => Response.json(bundle)) as typeof fetch,
      }),
    ).resolves.toMatchObject({ rules: [{ rollout: { id: "rollout-1", allocationBps: 500 } }] });

    await expect(
      exportPolicy({
        apiKey: "workspace-key",
        fetchImpl: (async () =>
          Response.json({
            ...bundle,
            rules: [{ ...bundle.rules[0], rollout: { ...bundle.rules[0].rollout, allocationBps: 10_001 } }],
          })) as typeof fetch,
      }),
    ).rejects.toThrow("invalid policy bundle");
  });
});
