import * as crypto from "crypto";
import * as http from "http";

import fixtures from "./fixtures/shared-cache-v1.json";
import { CloudAdapter } from "../src/adapters/cloud";
import {
  SHARED_EXACT_CACHE_KEY_VERSION,
  canonicalJson,
  sharedExactCacheKey,
  sharedExactCacheKeyInput,
} from "../src/shared-cache";

describe("shared exact cache key conformance", () => {
  it("keeps the fixture on the current key version", () => {
    expect(fixtures.protocol).toBe(SHARED_EXACT_CACHE_KEY_VERSION);
  });

  it.each(fixtures.cases)("$name", ({ keySalt, ruleId, request, expectedInput, expectedKey }) => {
    expect(sharedExactCacheKeyInput(ruleId, request)).toBe(expectedInput);
    expect(sharedExactCacheKey(keySalt, ruleId, request)).toBe(expectedKey);
  });

  it("drops undefined members, keeps nulls and array positions, and sorts keys by code unit", () => {
    expect(canonicalJson({ b: undefined, a: null, c: [undefined, 1] })).toBe('{"a":null,"c":[null,1]}');
    expect(canonicalJson({ b: 1, B: 2, a: 3, é: 4 })).toBe('{"B":2,"a":3,"b":1,"é":4}');
  });
});

describe("CloudAdapter shared exact cache", () => {
  const SALT = "c2hhcmVkLWNhY2hlLWZpeHR1cmUtc2FsdA";
  const request = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is our refund window?" }],
    temperature: 0,
  };
  const providerResponse = {
    object: "chat.completion",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 400, completion_tokens: 200 },
    choices: [{ message: { role: "assistant", content: "30 days." } }],
  };

  let server: http.Server;
  let port: number;
  let rulesResponse: Record<string, unknown>;
  let lookup: { status: number; body: Record<string, unknown>; delayMs?: number };
  let storeStatus: number;
  let calls: Array<{ path: string; body: any }>;

  function rule(shared = true) {
    return {
      id: "rule_cache_faq",
      name: "Cache FAQ answers",
      state: "ACTIVE",
      priority: 10,
      condition: { type: "always" },
      action: "CACHE_EXACT",
      actionParams: { cacheTtlSec: 300, ...(shared ? { shared: true } : {}) },
      requireEquivalencePct: null,
      modelAllowlist: [],
    };
  }

  const sharedSettings = {
    enabled: true,
    version: "shared-exact-v1",
    keySalt: SALT,
    timeoutMs: 150,
    maxResponseBytes: 262144,
  };

  beforeEach((done) => {
    rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedCache: sharedSettings };
    lookup = { status: 200, body: { hit: false } };
    storeStatus = 201;
    calls = [];
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/rules") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rulesResponse));
        return;
      }
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : null;
        calls.push({ path: req.url ?? "", body });
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url === "/v1/cache/lookup") {
          setTimeout(() => reply(lookup.status, lookup.body), lookup.delayMs ?? 0);
          return;
        }
        if (req.url === "/v1/cache/store") return reply(storeStatus, { stored: storeStatus === 201 });
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

  async function adapter(options: { onEnforcementError?: jest.Mock } = {}) {
    const instance = new CloudAdapter({
      apiKey: "workspace-key",
      endpoint: `http://localhost:${port}/v1/events`,
      ...(options.onEnforcementError ? { onEnforcementError: options.onEnforcementError } : {}),
    });
    await instance.warmEnforcement();
    return instance;
  }

  const paths = () => calls.map((call) => call.path);

  it("serves a shared hit without calling the provider, sending only the HMAC key", async () => {
    lookup = {
      status: 200,
      body: {
        hit: true,
        response: providerResponse,
        provider: "openai",
        model: "gpt-4o-mini",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);

    const response = await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();

    expect(response).toEqual(providerResponse);
    expect(provider).not.toHaveBeenCalled();
    const lookupCall = calls.find((call) => call.path === "/v1/cache/lookup")!;
    expect(lookupCall.body).toEqual({
      ruleId: "rule_cache_faq",
      key: crypto.createHmac("sha256", SALT).update(sharedExactCacheKeyInput("rule_cache_faq", request)).digest("hex"),
    });
    expect(JSON.stringify(lookupCall.body)).not.toContain("refund window");
    expect(calls.find((call) => call.path === "/v1/decisions")!.body).toMatchObject({
      ruleId: "rule_cache_faq",
      cacheOutcome: "hit",
      cacheStore: "shared",
      servedModel: "gpt-4o-mini",
      inputTokens: 400,
      outputTokens: 200,
    });
    expect(instance.getExactCacheStats()).toMatchObject({ hits: 1, misses: 0, sharedHits: 1, sharedLookupFailures: 0 });

    // The shared answer is now in the local cache, so the next identical request makes no lookup.
    calls = [];
    await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();
    expect(paths()).not.toContain("/v1/cache/lookup");
  });

  it("calls the provider on a shared miss and stores the response in the background", async () => {
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);

    await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();

    expect(provider).toHaveBeenCalledTimes(1);
    const store = calls.find((call) => call.path === "/v1/cache/store")!;
    expect(store.body).toMatchObject({
      ruleId: "rule_cache_faq",
      key: sharedExactCacheKey(SALT, "rule_cache_faq", request),
      response: providerResponse,
      provider: "openai",
      model: "gpt-4o-mini",
      costBasis: { inputTokens: 400, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ttlSec: 300,
    });
    expect(calls.find((call) => call.path === "/v1/decisions")!.body).toMatchObject({ cacheOutcome: "miss" });
    expect(instance.getExactCacheStats()).toMatchObject({ misses: 1, sharedStores: 1 });
  });

  it("falls back to the provider when the lookup times out or fails", async () => {
    lookup = { status: 200, body: { hit: true, response: providerResponse }, delayMs: 400 };
    const onEnforcementError = jest.fn();
    const instance = await adapter({ onEnforcementError });
    const provider = jest.fn(async () => providerResponse);

    await expect(instance.enforceRequest(request, provider, { provider: "openai" })).resolves.toEqual(providerResponse);
    await instance.flush();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(instance.getExactCacheStats()).toMatchObject({ sharedHits: 0, sharedLookupFailures: 1 });
    expect(onEnforcementError).toHaveBeenCalledWith(expect.any(Error), { operation: "shared_cache_lookup" });
  });

  it("stops using the shared cache until the next rules poll when TrAIce says it was turned off", async () => {
    lookup = { status: 403, body: { error: "shared_cache_disabled" } };
    const instance = await adapter({ onEnforcementError: jest.fn() });
    const provider = jest.fn(async () => providerResponse);

    await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.enforceRequest({ ...request, temperature: 0.5 }, provider, { provider: "openai" });
    await instance.flush();

    expect(paths().filter((path) => path === "/v1/cache/lookup")).toHaveLength(1);
    expect(paths()).not.toContain("/v1/cache/store");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("never touches the shared cache for unshared rules, opted-out workspaces, streams or bypassed requests", async () => {
    const provider = jest.fn(async () => providerResponse);

    rulesResponse = { ttlSeconds: 60, rules: [rule(false)], sharedCache: sharedSettings };
    const unshared = await adapter();
    await unshared.enforceRequest(request, provider, { provider: "openai" });
    await unshared.flush();

    rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedCache: null };
    const optedOut = await adapter();
    await optedOut.enforceRequest(request, provider, { provider: "openai" });
    await optedOut.flush();

    rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedCache: sharedSettings };
    const other = await adapter();
    await other.enforceRequest({ ...request, stream: true }, provider, { provider: "openai" });
    await other.enforceRequest(request, provider, { provider: "openai", bypass: true });
    await other.flush();

    expect(paths()).not.toContain("/v1/cache/lookup");
    expect(paths()).not.toContain("/v1/cache/store");
  });

  it("keeps responses over the size limit in the local cache only", async () => {
    rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedCache: { ...sharedSettings, maxResponseBytes: 64 } };
    const instance = await adapter();
    const provider = jest.fn(async () => ({ ...providerResponse, padding: "x".repeat(10_000) }));

    await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();

    expect(paths()).toContain("/v1/cache/lookup");
    expect(paths()).not.toContain("/v1/cache/store");
  });

  it("ignores shared cache settings with an unknown key version or a missing salt", async () => {
    const provider = jest.fn(async () => providerResponse);
    for (const sharedCache of [
      { ...sharedSettings, version: "shared-exact-v2" },
      { ...sharedSettings, keySalt: undefined },
      { ...sharedSettings, enabled: false },
    ]) {
      rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedCache };
      const instance = await adapter();
      await instance.enforceRequest(request, provider, { provider: "openai" });
      await instance.flush();
    }
    expect(paths()).not.toContain("/v1/cache/lookup");
  });
});
