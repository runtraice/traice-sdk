import { askTraice, normalizeServerUrl } from "../src/ask";

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

  it("requires HTTPS except for local development", () => {
    expect(() => normalizeServerUrl("http://example.com")).toThrow("must use HTTPS");
    expect(normalizeServerUrl("http://localhost:3000/")).toBe("http://localhost:3000");
  });
});
