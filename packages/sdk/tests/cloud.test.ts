import { CloudAdapter, TraiceEnforcementError, toCloudEvent } from "../src/adapters/cloud";
import { CostEvent } from "../src/types";
import * as http from "http";

function makeEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    id: "evt-1",
    timestamp: "2025-04-05T10:00:00Z",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputTokens: 400,
    outputTokens: 200,
    totalTokens: 600,
    inputCostUSD: 0.0012,
    outputCostUSD: 0.003,
    totalCostUSD: 0.0042,
    latencyMs: 500,
    feature: "test",
    ...overrides,
  };
}

describe("CloudAdapter", () => {
  let server: http.Server;
  let port: number;
  let receivedBodies: any[];
  let receivedHeaders: any;
  let rulesResponse: Record<string, unknown>;

  beforeEach((done) => {
    receivedBodies = [];
    receivedHeaders = {};
    rulesResponse = { ttlSeconds: 60, rules: [] };
    server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      if (req.method === "GET" && req.url === "/v1/rules") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rulesResponse));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedBodies.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"received":1}');
      });
    });
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('has name "cloud"', () => {
    const adapter = new CloudAdapter({ apiKey: "test-key" });
    expect(adapter.name).toBe("cloud");
  });

  it("sends Authorization header with API key", async () => {
    const adapter = new CloudAdapter({
      apiKey: "lm_live_test123",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 1,
    });

    await adapter.write(makeEvent());
    await adapter.flush();

    expect(receivedHeaders["authorization"]).toBe("Bearer lm_live_test123");
    expect(receivedHeaders["x-source"]).toBe("traice-sdk");
  });

  it("sends events as { events: [...] } batch", async () => {
    const adapter = new CloudAdapter({
      apiKey: "test-key",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 1,
    });

    await adapter.write(makeEvent({ id: "cloud-1" }));
    await adapter.flush();

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0].events).toHaveLength(1);
    expect(receivedBodies[0].events[0]).toEqual({
      ts: "2025-04-05T10:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      feature: "test",
      promptTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      costUsd: 0.0042,
      latencyMs: 500,
      metadata: {},
    });
  });

  it("serializes first-class SDK dimensions to the exact cloud ingest payload", () => {
    expect(
      toCloudEvent(
        makeEvent({
          userId: "user-1",
          tenantId: "tenant-1",
          agentId: "agent-1",
          workflowId: "workflow-1",
          runId: "run-1",
          stepId: "step-1",
          toolName: "search",
          retryCount: 2,
          outcome: "resolved",
          prompt: "Summarize the ticket",
          output: "Ticket summary",
          status: "success",
          promptName: "support-agent",
          promptVersion: "v2",
          sessionId: "sess-1",
          env: "test",
          metadata: { traceId: "trace-1" },
          tags: { tenantId: "legacy-tenant", suite: "smoke" },
        }),
      ),
    ).toEqual({
      ts: "2025-04-05T10:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      feature: "test",
      userId: "user-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      workflowId: "workflow-1",
      runId: "run-1",
      stepId: "step-1",
      toolName: "search",
      retryCount: 2,
      outcome: "resolved",
      prompt: "Summarize the ticket",
      output: "Ticket summary",
      promptTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      costUsd: 0.0042,
      latencyMs: 500,
      status: "success",
      metadata: {
        traceId: "trace-1",
        promptName: "support-agent",
        promptVersion: "v2",
        sessionId: "sess-1",
        env: "test",
        tags: { tenantId: "legacy-tenant", suite: "smoke" },
      },
    });
  });

  it("serializes prompt-cache token buckets", () => {
    expect(
      toCloudEvent(
        makeEvent({
          inputTokens: 10_000,
          outputTokens: 500,
          totalTokens: 10_500,
          cacheReadTokens: 6_000,
          cacheWriteTokens: 1_000,
        }),
      ),
    ).toMatchObject({
      promptTokens: 10_000,
      outputTokens: 500,
      totalTokens: 10_500,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 1_000,
    });
  });

  it("maps legacy workflow tags into cloud fields while preserving metadata.tags", () => {
    const tags = {
      tenantId: "legacy-tenant",
      agentId: "legacy-agent",
      workflowId: "legacy-workflow",
      runId: "legacy-run",
      stepId: "legacy-step",
      toolName: "legacy-tool",
      retryCount: "3",
      outcome: "legacy-outcome",
      customTag: "kept",
    };

    expect(
      toCloudEvent(
        makeEvent({
          metadata: { source: "legacy-tags" },
          tags,
        }),
      ),
    ).toEqual({
      ts: "2025-04-05T10:00:00Z",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      feature: "test",
      tenantId: "legacy-tenant",
      agentId: "legacy-agent",
      workflowId: "legacy-workflow",
      runId: "legacy-run",
      stepId: "legacy-step",
      toolName: "legacy-tool",
      retryCount: 3,
      outcome: "legacy-outcome",
      promptTokens: 400,
      outputTokens: 200,
      totalTokens: 600,
      costUsd: 0.0042,
      latencyMs: 500,
      metadata: {
        source: "legacy-tags",
        tags,
      },
    });
  });

  it("posts exact cloud payload for dimensions, samples, metadata, and tags", async () => {
    const adapter = new CloudAdapter({
      apiKey: "test-key",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 1,
    });

    await adapter.write(
      makeEvent({
        userId: "user-1",
        tenantId: "tenant-1",
        agentId: "agent-1",
        workflowId: "workflow-1",
        runId: "run-1",
        stepId: "step-1",
        toolName: "search",
        retryCount: 1,
        outcome: "success",
        prompt: "Prompt text",
        output: "Output text",
        status: "success",
        cached: true,
        promptName: "support-agent",
        promptVersion: "v2",
        sessionId: "sess-1",
        env: "test",
        metadata: { requestId: "req-1" },
        tags: { tenantId: "legacy-tenant", team: "support" },
      }),
    );
    await adapter.flush();

    expect(receivedBodies).toEqual([
      {
        events: [
          {
            ts: "2025-04-05T10:00:00Z",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            feature: "test",
            userId: "user-1",
            tenantId: "tenant-1",
            agentId: "agent-1",
            workflowId: "workflow-1",
            runId: "run-1",
            stepId: "step-1",
            toolName: "search",
            retryCount: 1,
            outcome: "success",
            prompt: "Prompt text",
            output: "Output text",
            promptTokens: 400,
            outputTokens: 200,
            totalTokens: 600,
            costUsd: 0.0042,
            latencyMs: 500,
            status: "success",
            metadata: {
              requestId: "req-1",
              cached: true,
              promptName: "support-agent",
              promptVersion: "v2",
              sessionId: "sess-1",
              env: "test",
              tags: { tenantId: "legacy-tenant", team: "support" },
            },
          },
        ],
      },
    ]);
  });

  it("batches events before sending", async () => {
    const adapter = new CloudAdapter({
      apiKey: "test-key",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 3,
      flushIntervalMs: 60000,
    });

    await adapter.write(makeEvent({ id: "b1" }));
    await adapter.write(makeEvent({ id: "b2" }));
    expect(receivedBodies).toHaveLength(0);

    await adapter.write(makeEvent({ id: "b3" }));
    // Wait for async flush
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0].events).toHaveLength(3);

    await adapter.flush();
  });

  it("flush() sends remaining buffer", async () => {
    const adapter = new CloudAdapter({
      apiKey: "test-key",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 100,
      flushIntervalMs: 60000,
    });

    await adapter.write(makeEvent({ id: "f1" }));
    await adapter.write(makeEvent({ id: "f2" }));
    expect(receivedBodies).toHaveLength(0);

    await adapter.flush();
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0].events).toHaveLength(2);
  });

  it("throws on server errors and keeps the failed event buffered for retry", async () => {
    server.close();
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          res.writeHead(500);
          res.end("Server Error");
        });
      });
      server.listen(port, resolve);
    });

    const adapter = new CloudAdapter({
      apiKey: "test-key",
      endpoint: `http://localhost:${port}/v1/events`,
      batchSize: 1,
    });

    await expect(adapter.write(makeEvent())).rejects.toThrow("CloudAdapter failed: 500");

    await new Promise<void>((resolve) => {
      server.close(() => {
        server = http.createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            receivedBodies.push(JSON.parse(body));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end('{"received":1}');
          });
        });
        server.listen(port, resolve);
      });
    });

    await adapter.flush();
    expect(receivedBodies).toHaveLength(1);
  });

  describe("enforceExactCache", () => {
    const request = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
    };

    function activeRule(overrides: Record<string, unknown> = {}) {
      return {
        id: "rule-cache",
        name: "Cache repeated chat",
        state: "ACTIVE",
        priority: 10,
        condition: { type: "always" },
        action: "CACHE_EXACT",
        actionParams: { cacheTtlSec: 300 },
        requireEquivalencePct: null,
        modelAllowlist: [],
        ...overrides,
      };
    }

    function chatCompletionResponse() {
      return {
        object: "chat.completion",
        model: "gpt-4o-mini",
        usage: { prompt_tokens: 400, completion_tokens: 200 },
        choices: [{ message: { role: "assistant", content: "Hi" } }],
      };
    }

    it("short-circuits normalized requests and exposes hit-rate and savings metrics", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule()] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => chatCompletionResponse());

      await adapter.enforceExactCache(request, provider);
      await adapter.enforceExactCache({ temperature: 0, messages: request.messages, model: request.model }, provider);
      await adapter.flush();

      expect(provider).toHaveBeenCalledTimes(1);
      expect(receivedBodies).toContainEqual(
        expect.objectContaining({
          ruleId: "rule-cache",
          requestedModel: "gpt-4o-mini",
          provider: "openai",
          servedModel: "gpt-4o-mini",
          inputTokens: 400,
          outputTokens: 200,
        }),
      );
      expect(adapter.getExactCacheStats()).toEqual({
        hits: 1,
        misses: 1,
        bypasses: 0,
        size: 1,
        hitRate: 0.5,
        savingsUsd: expect.any(Number),
      });
      expect(adapter.getExactCacheStats().savingsUsd).toBeGreaterThan(0);
    });

    it("prices OpenAI Responses API usage as OpenAI savings", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule()] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => ({
        object: "response",
        model: "gpt-4o-mini",
        usage: {
          input_tokens: 400,
          output_tokens: 200,
          input_tokens_details: { cached_tokens: 100 },
        },
        output: [],
      }));

      await adapter.enforceExactCache(request, provider);
      await adapter.enforceExactCache(request, provider);
      await adapter.flush();

      const decision = receivedBodies.find((body) => body.ruleId === "rule-cache" && body.cacheOutcome === "hit");
      expect(decision).toMatchObject({
        provider: "openai",
        servedModel: "gpt-4o-mini",
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 100,
      });
      expect(adapter.getExactCacheStats().savingsUsd).toBeGreaterThan(0);
    });

    it("always bypasses one-shot streaming responses", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule()] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => ({ async *[Symbol.asyncIterator]() {} }));
      const streamingRequest = { ...request, stream: true };

      await adapter.enforceExactCache(streamingRequest, provider);
      await adapter.enforceExactCache(streamingRequest, provider);
      await adapter.flush();

      expect(provider).toHaveBeenCalledTimes(2);
      expect(adapter.getExactCacheStats()).toEqual({
        hits: 0,
        misses: 0,
        bypasses: 2,
        size: 0,
        hitRate: 0,
        savingsUsd: 0,
      });
      expect(receivedBodies.some((body) => body.ruleId)).toBe(false);
    });

    it("honors explicit and header bypasses", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule()] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => chatCompletionResponse());

      await adapter.enforceExactCache(request, provider);
      await adapter.enforceExactCache(request, provider, { bypass: true });
      await adapter.enforceExactCache(request, provider, { headers: { "X-Traice-Cache-Bypass": "1" } });
      await adapter.flush();

      expect(provider).toHaveBeenCalledTimes(3);
      expect(adapter.getExactCacheStats().bypasses).toBe(2);
    });

    it("expires entries at the rule TTL", async () => {
      rulesResponse = {
        ttlSeconds: 60,
        rules: [activeRule({ actionParams: { cacheTtlSec: 1 } })],
      };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => chatCompletionResponse());
      const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);

      await adapter.enforceExactCache(request, provider);
      now.mockReturnValue(1_001_001);
      await adapter.enforceExactCache(request, provider);
      await adapter.flush();
      now.mockRestore();

      expect(provider).toHaveBeenCalledTimes(2);
      expect(adapter.getExactCacheStats().misses).toBe(2);
    });

    it("fails open and calls a failing provider exactly once", async () => {
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: "http://127.0.0.1:1/v1/events",
        enforcementTimeoutMs: 100,
      });
      const provider = jest.fn(async () => {
        throw new Error("provider failed");
      });

      await expect(adapter.enforceExactCache(request, provider)).rejects.toThrow("provider failed");
      await adapter.flush();

      expect(provider).toHaveBeenCalledTimes(1);
    });
  });

  describe("enforceRequest", () => {
    const request = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    };

    function activeRule(action: "DENY" | "CAP_RETRIES", actionParams: Record<string, unknown> = {}) {
      return {
        id: `rule-${action.toLowerCase()}`,
        name: action === "DENY" ? "Block support calls" : "Stop retry loops",
        state: "ACTIVE",
        priority: 10,
        condition: { type: "always" },
        action,
        actionParams,
        requireEquivalencePct: null,
        modelAllowlist: [],
      };
    }

    it("blocks an active deny rule without calling the provider and posts a Decision Record", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule("DENY")] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => ({ ok: true }));

      const blocked = adapter.enforceRequest(request, provider, { feature: "support" });
      await expect(blocked).rejects.toBeInstanceOf(TraiceEnforcementError);
      await expect(blocked).rejects.toMatchObject({
        code: "TRAICE_REQUEST_BLOCKED",
        action: "DENY",
        ruleId: "rule-deny",
      });
      await adapter.flush();

      expect(provider).not.toHaveBeenCalled();
      expect(receivedBodies).toContainEqual(
        expect.objectContaining({
          ruleId: "rule-deny",
          action: "DENY",
          requestedModel: "gpt-4o-mini",
        }),
      );
    });

    it("passes through shadow deny rules", async () => {
      rulesResponse = {
        ttlSeconds: 60,
        rules: [{ ...activeRule("DENY"), state: "SHADOW" }],
      };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => ({ ok: true }));

      await expect(adapter.enforceRequest(request, provider)).resolves.toEqual({ ok: true });
      await adapter.flush();

      expect(provider).toHaveBeenCalledWith(request);
      expect(receivedBodies.some((body) => body.ruleId)).toBe(false);
    });

    it("allows configured retries and blocks only the first retry over the cap", async () => {
      rulesResponse = { ttlSeconds: 60, rules: [activeRule("CAP_RETRIES", { maxRetries: 2 })] };
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: `http://localhost:${port}/v1/events`,
      });
      const provider = jest.fn(async () => ({ ok: true }));

      await expect(adapter.enforceRequest(request, provider, { retryCount: 2 })).resolves.toEqual({ ok: true });
      await expect(adapter.enforceRequest(request, provider, { retryCount: 3 })).rejects.toMatchObject({
        action: "CAP_RETRIES",
        ruleId: "rule-cap_retries",
      });
      await adapter.flush();

      expect(provider).toHaveBeenCalledTimes(1);
      expect(receivedBodies).toContainEqual(expect.objectContaining({ action: "CAP_RETRIES", retryCount: 3 }));
    });

    it("fails open when rules cannot be fetched", async () => {
      const adapter = new CloudAdapter({
        apiKey: "workspace-key",
        endpoint: "http://127.0.0.1:1/v1/events",
        enforcementTimeoutMs: 100,
      });
      const provider = jest.fn(async () => ({ ok: true }));

      await expect(adapter.enforceRequest(request, provider)).resolves.toEqual({ ok: true });
      expect(provider).toHaveBeenCalledTimes(1);
    });
  });
});
