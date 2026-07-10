import { describe, expect, it } from "vitest";
import { normalizeInternalUsageEvent, redactMetadata, stableSourceEventId } from "../src";

describe("@traice/protocol", () => {
  it("normalizes token totals and timestamps", () => {
    const event = normalizeInternalUsageEvent({
      sourceKey: " claude-code-local ",
      sourceKind: "claude_code_otel",
      tool: "claude-code",
      category: "coding_agent",
      sourceEventId: " event-1 ",
      occurredAt: "2026-07-10T00:00:00.000Z",
      inputTokens: 10.8,
      outputTokens: 3.2,
    });

    expect(event.sourceKey).toBe("claude-code-local");
    expect(event.sourceEventId).toBe("event-1");
    expect(event.inputTokens).toBe(10);
    expect(event.outputTokens).toBe(3);
    expect(event.totalTokens).toBe(13);
    expect(event.status).toBe("unknown");
  });

  it("redacts sensitive metadata", () => {
    expect(redactMetadata({ authorization: "Bearer token", nested: { apiKey: "sk-secretsecretsecret" } })).toEqual({
      authorization: "[redacted]",
      nested: { apiKey: "[redacted]" },
    });
  });

  it("builds stable source event ids from defined parts", () => {
    expect(stableSourceEventId(["claude", undefined, "session", 1])).toBe("claude:session:1");
  });
});
