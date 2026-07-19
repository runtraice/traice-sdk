import { askTraice, confirmAskAction, normalizeServerUrl, prepareAskAction } from "../src/ask";

describe("askTraice", () => {
  afterEach(() => jest.restoreAllMocks());

  it("sends a workspace bearer key and returns the formatted answer", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          question: "top spend",
          interpretedQuery: "Spend by feature, 30d",
          router: "fallback",
          calls: [],
          results: [],
          answer: "answer text",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await askTraice("top spend", {
      apiKey: "lm_live_secret",
      serverUrl: "https://www.runtraice.com/",
    });

    expect(result.answer).toBe("answer text");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.runtraice.com/api/v1/ask",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer lm_live_secret" }),
        body: JSON.stringify({ question: "top spend" }),
      }),
    );
  });

  it("does not include the API key in server errors", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401 }));

    await expect(askTraice("top spend", { apiKey: "lm_live_secret" })).rejects.toThrow(
      "trAIce ask failed: invalid_api_key",
    );
  });

  it("prepares and confirms an action through the dedicated endpoints", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "confirmation_required",
            confirmationId: "confirmation-1",
            action: "create_budget",
            summary: "Create a budget.",
            confirmationToken: "short-lived-token",
            confirmationPhrase: "CONFIRM ABC123",
            expiresAt: "2026-07-19T12:10:00.000Z",
            workspacePlan: "TEAM",
            instruction: "Confirm only after review.",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "confirmed",
            confirmationId: "confirmation-1",
            result: { budgetId: "budget-1" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const options = { apiKey: "lm_live_secret", serverUrl: "https://www.runtraice.com" };

    const prepared = await prepareAskAction({ action: "create_budget", name: "Support", limitUsd: 500 }, options);
    const confirmed = await confirmAskAction(prepared.confirmationToken, prepared.confirmationPhrase, options);

    expect(confirmed.result).toEqual({ budgetId: "budget-1" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.runtraice.com/api/v1/ask/actions/prepare",
      expect.objectContaining({ body: JSON.stringify({ action: "create_budget", name: "Support", limitUsd: 500 }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.runtraice.com/api/v1/ask/actions/confirm",
      expect.objectContaining({
        body: JSON.stringify({
          confirmationToken: "short-lived-token",
          confirmationPhrase: "CONFIRM ABC123",
        }),
      }),
    );
  });

  it("requires HTTPS except for local development", () => {
    expect(() => normalizeServerUrl("http://example.com")).toThrow("must use HTTPS");
    expect(normalizeServerUrl("http://localhost:3000/")).toBe("http://localhost:3000");
  });
});
