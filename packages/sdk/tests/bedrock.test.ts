import { configure, CostAdapter, CostEvent, meter, resetConfig } from "../src";

class TestAdapter implements CostAdapter {
  name = "test";
  events: CostEvent[] = [];

  async write(event: CostEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("Amazon Bedrock Converse", () => {
  afterEach(() => resetConfig());

  it("meters a Converse response as aws-bedrock, counting cache tokens in the input", async () => {
    const adapter = new TestAdapter();
    configure({ adapters: [adapter], warnOnMissingModel: false });

    await meter(
      async () => ({
        output: { message: { role: "assistant", content: [{ text: "Refund issued." }] } },
        stopReason: "end_turn",
        usage: {
          inputTokens: 300,
          outputTokens: 40,
          totalTokens: 430,
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 10,
        },
        metrics: { latencyMs: 420 },
      }),
      { model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0", feature: "escalation-agent", awaitWrites: true },
    );

    expect(adapter.events[0]).toMatchObject({
      provider: "aws-bedrock",
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      inputTokens: 390,
      outputTokens: 40,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      feature: "escalation-agent",
    });
  });

  it("keeps the AI SDK usage shape on its existing path", async () => {
    const adapter = new TestAdapter();
    configure({ adapters: [adapter], warnOnMissingModel: false });

    await meter(async () => ({ usage: { inputTokens: 12, outputTokens: 3 } }), {
      model: "gpt-5.5",
      provider: "openai",
      awaitWrites: true,
    });

    expect(adapter.events[0]).toMatchObject({ provider: "openai", inputTokens: 12, outputTokens: 3 });
  });
});
