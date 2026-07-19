import {
  importLangfuse,
  importLiteLlm,
  mapLangfuseObservation,
  mapLiteLlmSpendLog,
  parseImportRange,
} from "../src/vendor-imports";

describe("vendor cost importers", () => {
  it("maps LiteLLM spend logs and excludes credentials and arbitrary payload metadata", () => {
    const event = mapLiteLlmSpendLog({
      request_id: "req-1",
      startTime: "2026-07-18T10:00:00.000Z",
      endTime: "2026-07-18T10:00:01.250Z",
      model: "openai/gpt-4o-mini",
      custom_llm_provider: "openai",
      spend: 0.0025,
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      request_tags: ["feature:support", "production"],
      metadata: {
        user_api_key: "secret-key-material",
        user_api_key_user_id: "employee-1",
        spend_logs_metadata: { tenant_id: "customer-1", run_id: "run-1", private: "do not copy" },
      },
    });

    expect(event).toMatchObject({
      source: "litellm",
      externalId: "req-1",
      provider: "openai",
      model: "gpt-4o-mini",
      feature: "support",
      userId: "employee-1",
      tenantId: "customer-1",
      runId: "run-1",
      promptTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costUsd: 0.0025,
      latencyMs: 1250,
    });
    expect(JSON.stringify(event)).not.toContain("secret-key-material");
    expect(JSON.stringify(event)).not.toContain("do not copy");
  });

  it("maps Langfuse v2 usage without copying observation input or output", () => {
    const event = mapLangfuseObservation({
      id: "obs-1",
      traceId: "trace-1",
      projectId: "project-1",
      type: "GENERATION",
      startTime: "2026-07-18T10:00:00.000Z",
      endTime: "2026-07-18T10:00:00.500Z",
      name: "support-answer",
      providedModelName: "anthropic/claude-sonnet-4",
      inputUsage: 50,
      outputUsage: 10,
      totalUsage: 60,
      totalCost: 0.01,
      userId: "user-1",
      traceName: "support-workflow",
      input: "private prompt",
      output: "private answer",
      metadata: { "traice.feature": "support", "traice.tenant_id": "customer-1", private: "ignore" },
    });

    expect(event).toMatchObject({
      source: "langfuse",
      externalId: "obs-1",
      feature: "support",
      tenantId: "customer-1",
      workflowId: "support-workflow",
      runId: "trace-1",
      stepId: "obs-1",
      promptTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      costUsd: 0.01,
      latencyMs: 500,
    });
    expect(JSON.stringify(event)).not.toContain("private prompt");
    expect(JSON.stringify(event)).not.toContain("private answer");
    expect(JSON.stringify(event)).not.toContain("ignore");
  });

  it("parses duration and absolute import ranges against a fixed upper boundary", () => {
    const now = new Date("2026-07-19T12:00:00.000Z");
    expect(parseImportRange("7d", undefined, now)).toEqual({
      since: new Date("2026-07-12T12:00:00.000Z"),
      until: now,
    });
    expect(parseImportRange("2026-07-01", "2026-07-02", now)).toEqual({
      since: new Date("2026-07-01T00:00:00.000Z"),
      until: new Date("2026-07-02T00:00:00.000Z"),
    });
    expect(() => parseImportRange("tomorrow-ish", undefined, now)).toThrow("ISO date or a duration");
  });

  it("fetches LiteLLM individual logs and reports server deduplication", async () => {
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/spend/logs")) {
        expect(url).toContain("summarize=false");
        expect(init?.headers).toEqual({ authorization: "Bearer lite-secret" });
        return Response.json([
          {
            request_id: "req-1",
            startTime: "2026-07-18T10:00:00.000Z",
            model: "gpt-4o-mini",
            prompt_tokens: 10,
            completion_tokens: 2,
            spend: 0.001,
          },
        ]);
      }
      expect(url).toBe("https://www.runtraice.com/api/v1/events");
      expect(init?.headers).toEqual({ authorization: "Bearer traice-secret", "content-type": "application/json" });
      const body = JSON.parse(String(init?.body)) as {
        events: Array<{ source: string; externalId: string; status: string }>;
      };
      expect(body.events).toEqual([
        expect.objectContaining({
          source: "litellm",
          externalId: expect.stringMatching(/^[0-9a-f]{16}:req-1$/),
          status: "success",
        }),
      ]);
      return Response.json({ accepted: 0, deduplicated: 1, quotaDropped: 0, dropped: 1, plan: "TEAM" });
    });

    const result = await importLiteLlm({
      baseUrl: "https://litellm.example.com",
      apiKey: "lite-secret",
      traice: { apiKey: "traice-secret" },
      since: new Date("2026-07-18T00:00:00.000Z"),
      until: new Date("2026-07-19T00:00:00.000Z"),
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toEqual({
      source: "litellm",
      fetched: 1,
      mapped: 1,
      ignored: 0,
      accepted: 0,
      deduplicated: 1,
      quotaDropped: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("follows Langfuse cursors and never requests I/O fields", async () => {
    let langfusePage = 0;
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "cloud.langfuse.com") {
        expect(url.searchParams.get("fields")).not.toContain("io");
        expect(url.searchParams.get("type")).toBe("GENERATION");
        expect(init?.headers).toEqual({ authorization: expect.stringMatching(/^Basic /) });
        langfusePage += 1;
        return Response.json({
          data: [
            {
              id: `obs-${langfusePage}`,
              traceId: `trace-${langfusePage}`,
              startTime: `2026-07-18T1${langfusePage}:00:00.000Z`,
              providedModelName: "gpt-4o-mini",
              inputUsage: 10,
              outputUsage: 2,
              totalCost: 0.001,
            },
          ],
          meta: { cursor: langfusePage === 1 ? "next-page" : null },
        });
      }
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      expect(body.events).toHaveLength(1);
      return Response.json({ accepted: 1, deduplicated: 0, quotaDropped: 0, dropped: 0, plan: "TEAM" });
    });

    const result = await importLangfuse({
      publicKey: "pk-lf",
      secretKey: "sk-lf",
      traice: { apiKey: "traice-secret" },
      since: new Date("2026-07-18T00:00:00.000Z"),
      until: new Date("2026-07-19T00:00:00.000Z"),
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(result).toMatchObject({ source: "langfuse", fetched: 2, mapped: 2, accepted: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("retries a rate-limited vendor request without duplicating the upload", async () => {
    let attempts = 0;
    const fetchMock = jest.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/spend/logs")) {
        attempts += 1;
        if (attempts === 1) {
          return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        }
        return Response.json([
          {
            request_id: "req-retried",
            startTime: "2026-07-18T10:00:00.000Z",
            model: "gpt-4o-mini",
            spend: 0.001,
          },
        ]);
      }
      return Response.json({ accepted: 1, deduplicated: 0, quotaDropped: 0 });
    });

    const result = await importLiteLlm({
      baseUrl: "https://litellm.example.com",
      apiKey: "lite-secret",
      traice: { apiKey: "traice-secret" },
      since: new Date("2026-07-18T00:00:00.000Z"),
      until: new Date("2026-07-19T00:00:00.000Z"),
      fetchImpl: fetchMock as typeof fetch,
    });

    expect(attempts).toBe(2);
    expect(result.accepted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
