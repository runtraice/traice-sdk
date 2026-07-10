import { CloudAdapter, toCloudEvent } from "../src/adapters/cloud";
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

  beforeEach((done) => {
    receivedBodies = [];
    receivedHeaders = {};
    server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
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
});
