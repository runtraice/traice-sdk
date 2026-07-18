import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalUsageEvent } from "@traice/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSourceForAgent } from "../src/config";
import { readCollectorCredential, storeCollectorCredential } from "../src/credentials";
import { installAgent } from "../src/install";
import { normalizeClaudeCodeOtlpLogs, normalizeClaudeCodeOtlpMetrics } from "../src/adapters/claude-code";
import { normalizeCodexOtlpLogs } from "../src/adapters/codex";
import { createSerializedEventForwarder, forwardEvents, normalizePayloadForRequest } from "../src/run";
import type { CollectorConfig } from "../src/types";

const identity = {
  employeeEmail: "alex@example.com",
  employeeName: "Alex",
  teamName: "Engineering",
  sourcePrincipal: "host:user",
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("@traice/collector", () => {
  it("normalizes Claude Code OTLP log token records", () => {
    const events = normalizeClaudeCodeOtlpLogs(logPayload("claude", "claude-3-5-sonnet", 12, 8), {
      source: defaultSourceForAgent("claude-code"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceKey: "claude-code-local",
      tool: "claude-code",
      employeeEmail: "alex@example.com",
      model: "claude-3-5-sonnet",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
  });

  it("normalizes Claude Code OTLP metric token points", () => {
    const events = normalizeClaudeCodeOtlpMetrics(metricPayload("gen_ai.client.token.usage.input", 42), {
      source: defaultSourceForAgent("claude-code"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.inputTokens).toBe(42);
  });

  it("normalizes Codex OTLP logs through the same protocol", () => {
    const events = normalizeCodexOtlpLogs(logPayload("codex", "gpt-5-codex", 7, 2), {
      source: defaultSourceForAgent("codex"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      sourceKey: "codex-local",
      tool: "codex",
      model: "gpt-5-codex",
      totalTokens: 9,
    });
  });

  it("does not duplicate ambiguous payloads when multiple agents are enabled", () => {
    const config: CollectorConfig = {
      version: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      serverUrl: "https://runtraice.com",
      listenHost: "127.0.0.1",
      listenPort: 4318,
      includePrompts: false,
      enabledAgents: ["claude-code", "codex"],
      identity,
      sources: {
        "claude-code": defaultSourceForAgent("claude-code"),
        codex: defaultSourceForAgent("codex"),
      },
    };

    expect(
      normalizePayloadForRequest("/v1/logs", logPayload("unknown", "model", 1, 1), config, undefined, config.createdAt),
    ).toEqual([]);
    expect(
      normalizePayloadForRequest("/v1/logs", logPayload("codex", "model", 1, 1), config, undefined, config.createdAt),
    ).toHaveLength(1);
  });

  it("forwards large payloads in bounded batches", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      return Response.json({ accepted: body.events.length });
    });

    const sent = await forwardEvents(
      collectorConfig(),
      Array.from({ length: 23 }, (_, i) => usageEvent(i)),
      {
        fetchImpl,
        batchSize: 10,
      },
    );

    expect(sent).toBe(23);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events.length)).toEqual([10, 10, 3]);
  });

  it("retries transient downstream failures with exponential backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ accepted: 1 }));
    const sleep = vi.fn(async () => undefined);

    await expect(forwardEvents(collectorConfig(), [usageEvent(1)], { fetchImpl, sleep, maxAttempts: 3 })).resolves.toBe(
      1,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("serializes concurrent forwarding requests", async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (fetchImpl.mock.calls.length === 1) await firstResponse;
      active -= 1;
      return Response.json({ accepted: 1 });
    });
    const enqueue = createSerializedEventForwarder({ fetchImpl });

    const first = enqueue(collectorConfig(), [usageEvent(1)]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = enqueue(collectorConfig(), [usageEvent(2)]);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(maxActive).toBe(1);
  });

  it("stores credentials through an OS keyring reference without writing the secret to config", async () => {
    const passwords = new Map<string, string>();
    const dependencies = {
      createKeyringEntry: (service: string, account: string) => ({
        setPassword: async (password: string) => {
          passwords.set(`${service}:${account}`, password);
        },
        getPassword: async () => passwords.get(`${service}:${account}`),
      }),
    };
    const result = await storeCollectorCredential(
      "/tmp/traice-test/config.json",
      "secret-value",
      "keyring",
      dependencies,
    );

    expect(result.credential.backend).toBe("os-keyring");
    expect(await readCollectorCredential(result.credential, dependencies)).toBe("secret-value");
    expect(JSON.stringify(result.credential)).not.toContain("secret-value");
  });

  it("uses a protected-file fallback without keeping the key in collector config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-credentials-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      apiKey: "lm_live_test_secret",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });

    const configText = readFileSync(configPath, "utf8");
    const config = JSON.parse(configText) as CollectorConfig;
    expect(configText).not.toContain("lm_live_test_secret");
    expect(config.credential?.backend).toBe("protected-file");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(await readCollectorCredential(config.credential!)).toBe("lm_live_test_secret");
  });
});

function collectorConfig(): CollectorConfig {
  return {
    version: 1,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    serverUrl: "https://runtraice.com",
    apiKey: "lm_test",
    listenHost: "127.0.0.1",
    listenPort: 4318,
    includePrompts: false,
    enabledAgents: ["codex"],
    identity,
    sources: { codex: defaultSourceForAgent("codex") },
  };
}

function usageEvent(index: number): InternalUsageEvent {
  return {
    occurredAt: "2026-07-10T00:00:00.000Z",
    sourceKey: "codex-local",
    sourceName: "Codex local collector",
    sourceKind: "codex_otel",
    tool: "codex",
    category: "coding_agent",
    sourceEventId: `event-${index}`,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: 0,
    costBasis: "usage_only",
  };
}

function logPayload(serviceName: string, model: string, inputTokens: number, outputTokens: number) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1783641600000000000",
                severityText: "INFO",
                body: { stringValue: "response.completed" },
                attributes: [
                  { key: "event.name", value: { stringValue: "response.completed" } },
                  { key: "gen_ai.request.model", value: { stringValue: model } },
                  { key: "session.id", value: { stringValue: "session-1" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: String(inputTokens) } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: String(outputTokens) } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function metricPayload(metricName: string, value: number) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: "1783641600000000000",
                      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "claude-3-5-sonnet" } }],
                      asInt: String(value),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
