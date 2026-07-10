import { describe, expect, it } from "vitest";
import { defaultSourceForAgent } from "../src/config";
import { normalizeClaudeCodeOtlpLogs, normalizeClaudeCodeOtlpMetrics } from "../src/adapters/claude-code";
import { normalizeCodexOtlpLogs } from "../src/adapters/codex";
import { normalizePayloadForRequest } from "../src/run";
import type { CollectorConfig } from "../src/types";

const identity = {
  employeeEmail: "alex@example.com",
  employeeName: "Alex",
  teamName: "Engineering",
  sourcePrincipal: "host:user",
};

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
      serverUrl: "https://app.runtraice.com",
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
});

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
