import { toCloudEvent } from "../src/adapters/cloud";
import { CAPTURED_REQUEST_LIMITS, captureRequest, configure, CostAdapter, CostEvent, meter, resetConfig } from "../src";

class TestAdapter implements CostAdapter {
  name = "test";
  events: CostEvent[] = [];

  async write(event: CostEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("captureRequest", () => {
  it("reduces an OpenAI chat request, joining leading system and developer messages", () => {
    expect(
      captureRequest({
        model: "gpt-5.5",
        temperature: 0.2,
        top_p: 0.9,
        max_completion_tokens: 400,
        messages: [
          { role: "system", content: "You are a support agent." },
          { role: "developer", content: [{ type: "text", text: "Answer in English." }] },
          { role: "user", content: "Where is my order?" },
          { role: "assistant", content: "Which order number?" },
          { role: "user", content: [{ type: "text", text: "A-1042" }] },
        ],
      }),
    ).toEqual({
      system: "You are a support agent.\n\nAnswer in English.",
      messages: [
        { role: "user", content: "Where is my order?" },
        { role: "assistant", content: "Which order number?" },
        { role: "user", content: "A-1042" },
      ],
      params: { temperature: 0.2, topP: 0.9, maxOutputTokens: 400 },
    });
  });

  it("reduces an Anthropic messages request with system blocks", () => {
    expect(
      captureRequest({
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        system: [{ type: "text", text: "Summarize tickets." }],
        messages: [{ role: "user", content: [{ type: "text", text: "Ticket body" }] }],
      }),
    ).toEqual({
      system: "Summarize tickets.",
      messages: [{ role: "user", content: "Ticket body" }],
      params: { maxOutputTokens: 1024 },
    });
  });

  it("reduces a Bedrock Converse request and ignores cache points", () => {
    expect(
      captureRequest({
        modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        system: [{ text: "Route escalations." }, { cachePoint: { type: "default" } }],
        messages: [{ role: "user", content: [{ text: "My refund failed" }, { cachePoint: { type: "default" } }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0, topP: 1 },
      }),
    ).toEqual({
      system: "Route escalations.",
      messages: [{ role: "user", content: "My refund failed" }],
      params: { temperature: 0, topP: 1, maxOutputTokens: 300 },
    });
  });

  it("accepts an already captured request unchanged", () => {
    const captured = {
      system: "Be brief.",
      messages: [{ role: "user" as const, content: "Hi" }],
      params: { temperature: 0.5, maxOutputTokens: 50 },
    };
    expect(captureRequest(captured)).toEqual(captured);
  });

  it.each([
    [
      "a tool result",
      {
        messages: [
          { role: "user", content: "Look it up" },
          { role: "tool", content: "{}", tool_call_id: "1" },
        ],
      },
    ],
    ["an assistant tool call", { messages: [{ role: "assistant", content: null, tool_calls: [{ id: "1" }] }] }],
    [
      "an image part",
      { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x" } }] }] },
    ],
    [
      "an Anthropic tool_use block",
      { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }] },
    ],
    ["a Converse toolUse block", { messages: [{ role: "assistant", content: [{ toolUse: { toolUseId: "t" } }] }] }],
    [
      "a system message after the conversation starts",
      {
        messages: [
          { role: "user", content: "Hi" },
          { role: "system", content: "Late instruction" },
        ],
      },
    ],
    ["an empty message", { messages: [{ role: "user", content: "" }] }],
    ["no messages", { messages: [] }],
    ["no messages array", { prompt: "Hi" }],
  ])("returns undefined for %s", (_label, input) => {
    expect(captureRequest(input)).toBeUndefined();
  });

  it("returns undefined above the message and size limits", () => {
    const tooMany = {
      messages: Array.from({ length: CAPTURED_REQUEST_LIMITS.maxMessages + 1 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x",
      })),
    };
    expect(captureRequest(tooMany)).toBeUndefined();
    const tooLarge = {
      messages: [{ role: "user", content: "x".repeat(CAPTURED_REQUEST_LIMITS.maxSerializedBytes) }],
    };
    expect(captureRequest(tooLarge)).toBeUndefined();
  });
});

describe("request on cost events", () => {
  afterEach(() => resetConfig());

  it("meter() reduces the request option onto the event", async () => {
    const adapter = new TestAdapter();
    configure({ adapters: [adapter], warnOnMissingModel: false });

    await meter(
      async () => ({
        model: "gpt-5.5",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }),
      {
        feature: "support",
        awaitWrites: true,
        request: {
          model: "gpt-5.5",
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Hi" },
          ],
        },
      },
    );

    expect(adapter.events[0].request).toEqual({ system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
  });

  it("the cloud payload carries the request only when content capture is on", () => {
    const event: CostEvent = {
      id: "evt-1",
      timestamp: "2026-11-03T00:00:00Z",
      provider: "openai",
      model: "gpt-5.5",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      inputCostUSD: 0,
      outputCostUSD: 0,
      totalCostUSD: 0,
      latencyMs: 100,
      request: { messages: [{ role: "user", content: "Hi" }] },
    };

    expect(toCloudEvent(event, { captureContent: true }).request).toEqual({
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(toCloudEvent(event, { captureContent: false }).request).toBeUndefined();
    expect(toCloudEvent(event).request).toBeUndefined();
  });
});
