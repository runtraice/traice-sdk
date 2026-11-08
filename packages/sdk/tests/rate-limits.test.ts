import * as http from "http";

import { CloudAdapter, TraiceEnforcementError } from "../src/adapters/cloud";

describe("CloudAdapter rate limits", () => {
  const request = { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] };
  const providerResponse = {
    object: "chat.completion",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 300, completion_tokens: 80 },
    choices: [{ message: { role: "assistant", content: "Hi." } }],
  };

  let server: http.Server;
  let port: number;
  let rulesResponse: Record<string, unknown>;
  let acquire: { status: number; body: Record<string, unknown>; delayMs?: number };
  let calls: Array<{ path: string; body: any; headers: http.IncomingHttpHeaders }>;
  let ruleHeaders: http.IncomingHttpHeaders[];

  function limit(overrides: Record<string, unknown> = {}) {
    return {
      id: "rule_rpm",
      name: "600 requests a minute per key",
      state: "ACTIVE",
      priority: 1,
      condition: { type: "always" },
      action: "RATE_LIMIT",
      actionParams: { requestsPerMinute: 600, per: "api_key" },
      requireEquivalencePct: null,
      modelAllowlist: [],
      ...overrides,
    };
  }
  const cacheRule = {
    id: "rule_cache",
    name: "Exact cache",
    state: "ACTIVE",
    priority: 10,
    condition: { type: "always" },
    action: "CACHE_EXACT",
    actionParams: { cacheTtlSec: 300 },
    requireEquivalencePct: null,
    modelAllowlist: [],
  };

  beforeEach((done) => {
    rulesResponse = {
      ttlSeconds: 60,
      rules: [limit()],
      rateLimit: { version: "rate-limit-v1", timeoutMs: 150 },
    };
    acquire = { status: 200, body: { allowed: true, shadowLimited: [] } };
    calls = [];
    ruleHeaders = [];
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/rules") {
        ruleHeaders.push(req.headers);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rulesResponse));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null, headers: req.headers });
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url === "/v1/rate-limits/acquire") {
          setTimeout(() => reply(acquire.status, acquire.body), acquire.delayMs ?? 0);
          return;
        }
        if (req.url === "/v1/rate-limits/usage") return reply(202, { ok: true, rules: 1 });
        reply(200, { accepted: 1 });
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

  async function adapter(onEnforcementError?: jest.Mock) {
    const instance = new CloudAdapter({
      apiKey: "workspace-key",
      endpoint: `http://localhost:${port}/v1/events`,
      ...(onEnforcementError ? { onEnforcementError } : {}),
    });
    await instance.warmEnforcement();
    return instance;
  }
  const acquires = () => calls.filter((call) => call.path === "/v1/rate-limits/acquire");

  it("asks for a protocol with rate limits and counts each matching request on trAIce", async () => {
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await expect(instance.enforceRequest(request, provider, { userId: "u-1" })).resolves.toBe(providerResponse);
    expect(Number(ruleHeaders[0]["x-traice-enforcement-version"])).toBeGreaterThanOrEqual(3);
    expect(acquires()).toHaveLength(1);
    expect(acquires()[0].body).toEqual({ ruleIds: ["rule_rpm"], userId: "u-1" });
    expect(acquires()[0].headers.authorization).toBe("Bearer workspace-key");
    expect(instance.getRateLimitStats()).toMatchObject({ acquired: 1, refused: 0 });
  });

  it("refuses with a structured error and refuses locally until the retry time passes", async () => {
    acquire = {
      status: 200,
      body: {
        allowed: false,
        ruleId: "rule_rpm",
        ruleName: "600 requests a minute per key",
        limit: "requests",
        value: 600,
        retryAfterMs: 5_000,
        shadowLimited: [],
      },
    };
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    const refused = await instance.enforceRequest(request, provider).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TraiceEnforcementError);
    expect(refused).toMatchObject({
      action: "RATE_LIMIT",
      ruleId: "rule_rpm",
      retryAfterMs: 5_000,
      reason: { type: "rate_limit", limit: "requests", value: 600, per: "api_key" },
    });
    expect((refused as TraiceEnforcementError).message).toBe("Rate limit reached: 600 requests a minute per key");

    const again = await instance.enforceRequest(request, provider).catch((error: unknown) => error);
    expect(again).toMatchObject({ action: "RATE_LIMIT", ruleId: "rule_rpm" });
    expect(acquires()).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
    expect(instance.getRateLimitStats()).toMatchObject({ refused: 1, refusedLocally: 1 });
  });

  it("keeps a per-user refusal to that user", async () => {
    rulesResponse.rules = [limit({ actionParams: { requestsPerMinute: 10, per: "user" } })];
    acquire = {
      status: 200,
      body: { allowed: false, ruleId: "rule_rpm", ruleName: "Per user", limit: "requests", retryAfterMs: 5_000 },
    };
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await expect(instance.enforceRequest(request, provider, { userId: "heavy" })).rejects.toBeInstanceOf(
      TraiceEnforcementError,
    );
    acquire = { status: 200, body: { allowed: true, shadowLimited: [] } };
    await expect(instance.enforceRequest(request, provider, { userId: "light" })).resolves.toBe(providerResponse);
    expect(acquires()).toHaveLength(2);
  });

  it("lets the call through when trAIce is slow or failing", async () => {
    const onError = jest.fn();
    acquire = { status: 200, body: { allowed: false, ruleId: "rule_rpm" }, delayMs: 400 };
    const instance = await adapter(onError);
    const provider = jest.fn(async () => providerResponse);
    await expect(instance.enforceRequest(request, provider)).resolves.toBe(providerResponse);

    acquire = { status: 429, body: { error: "rate_limited" } };
    await expect(instance.enforceRequest(request, provider)).resolves.toBe(providerResponse);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(instance.getRateLimitStats()).toMatchObject({ failOpen: 2, refused: 0 });
  });

  it("never lets a rate limit hide a later rule", async () => {
    rulesResponse.rules = [limit(), cacheRule];
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await instance.enforceRequest(request, provider);
    await instance.enforceRequest(request, provider);
    // The exact cache served the second call.
    expect(provider).toHaveBeenCalledTimes(1);
    expect(acquires()).toHaveLength(2);
  });

  it("reports tokens after the call only for rules that limit tokens", async () => {
    rulesResponse.rules = [limit({ actionParams: { tokensPerMinute: 50_000 } })];
    const instance = await adapter();
    await instance.enforceRequest(request, async () => providerResponse);
    await instance.flush();
    const usage = calls.filter((call) => call.path === "/v1/rate-limits/usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].body).toEqual({ ruleIds: ["rule_rpm"], tokens: 380 });

    rulesResponse.rules = [limit()];
    const requestsOnly = await adapter();
    await requestsOnly.enforceRequest(request, async () => providerResponse);
    await requestsOnly.flush();
    expect(calls.filter((call) => call.path === "/v1/rate-limits/usage")).toHaveLength(1);
  });

  it("does nothing for rate limits without protocol v3 settings or matching rules", async () => {
    rulesResponse = { ttlSeconds: 60, rules: [limit()] };
    const instance = await adapter();
    await instance.enforceRequest(request, async () => providerResponse);
    rulesResponse = {
      ttlSeconds: 60,
      rules: [limit({ condition: { type: "feature", equals: "billing" } })],
      rateLimit: { version: "rate-limit-v1", timeoutMs: 150 },
    };
    const other = await adapter();
    await other.enforceRequest(request, async () => providerResponse, { feature: "chat" });
    expect(acquires()).toHaveLength(0);
  });
});
