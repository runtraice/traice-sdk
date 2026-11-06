import * as http from "http";

import { CloudAdapter } from "../src/adapters/cloud";

describe("CloudAdapter shared semantic cache", () => {
  const request = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "How long do refunds take?" }],
  };
  const providerResponse = {
    object: "chat.completion",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 300, completion_tokens: 80 },
    choices: [{ message: { role: "assistant", content: "Five to seven business days." } }],
  };
  const embedding = [0.6, 0.8, 0];

  let server: http.Server;
  let port: number;
  let rulesResponse: Record<string, unknown>;
  let lookup: { status: number; body: Record<string, unknown>; delayMs?: number };
  let storeStatus: number;
  let calls: Array<{ path: string; body: any }>;

  function rule(shared = true) {
    return {
      id: "rule_semantic_faq",
      name: "Reuse similar answers",
      state: "ACTIVE",
      priority: 10,
      condition: { type: "always" },
      action: "CACHE_SEMANTIC",
      actionParams: { cacheTtlSec: 300, similarityThreshold: 0.9, ...(shared ? { shared: true } : {}) },
      requireEquivalencePct: null,
      modelAllowlist: [],
    };
  }

  const sharedSettings = {
    enabled: true,
    version: "shared-semantic-v1",
    timeoutMs: 300,
    maxResponseBytes: 262144,
    maxDimensions: 4096,
  };

  beforeEach((done) => {
    rulesResponse = { ttlSeconds: 60, rules: [rule()], sharedSemanticCache: sharedSettings };
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
        if (req.url === "/v1/cache/semantic/lookup") {
          setTimeout(() => reply(lookup.status, lookup.body), lookup.delayMs ?? 0);
          return;
        }
        if (req.url === "/v1/cache/semantic/store") return reply(storeStatus, { stored: storeStatus === 201 });
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

  async function adapter(options: { embeddingModel?: string; onEnforcementError?: jest.Mock } = {}) {
    const instance = new CloudAdapter({
      apiKey: "workspace-key",
      endpoint: `http://localhost:${port}/v1/events`,
      semanticCache: {
        embed: async () => embedding,
        ...("embeddingModel" in options
          ? options.embeddingModel === undefined
            ? {}
            : { embeddingModel: options.embeddingModel }
          : { embeddingModel: "text-embedding-3-small" }),
      },
      ...(options.onEnforcementError ? { onEnforcementError: options.onEnforcementError } : {}),
    });
    await instance.warmEnforcement();
    return instance;
  }

  const paths = () => calls.map((call) => call.path);

  it("serves a shared hit without calling the provider, sending only the embedding", async () => {
    lookup = {
      status: 200,
      body: {
        hit: true,
        response: providerResponse,
        provider: "openai",
        model: "gpt-4o-mini",
        similarity: 0.97,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);

    const response = await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();

    expect(response).toEqual(providerResponse);
    expect(provider).not.toHaveBeenCalled();
    const lookupCall = calls.find((call) => call.path === "/v1/cache/semantic/lookup");
    expect(lookupCall?.body).toEqual({
      ruleId: "rule_semantic_faq",
      requestedModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      embedding,
    });
    // The request text never leaves the process.
    expect(JSON.stringify(lookupCall?.body)).not.toContain("refunds");
    const decision = calls.find((call) => call.path === "/v1/decisions");
    expect(decision?.body).toMatchObject({ cacheOutcome: "hit", cacheStore: "shared", similarity: 0.97 });
    expect(instance.getSemanticCacheStats()).toMatchObject({ hits: 1, sharedHits: 1 });

    // The answer is now local too: a second identical call makes no lookup.
    await instance.enforceRequest(request, provider, { provider: "openai" });
    expect(paths().filter((path) => path === "/v1/cache/semantic/lookup")).toHaveLength(1);
  });

  it("stores the answer after a miss, with the embedding and no request text", async () => {
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await instance.enforceRequest(request, provider, { provider: "openai" });
    await instance.flush();

    expect(provider).toHaveBeenCalledTimes(1);
    const store = calls.find((call) => call.path === "/v1/cache/semantic/store");
    expect(store?.body).toMatchObject({
      ruleId: "rule_semantic_faq",
      requestedModel: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
      embedding,
      response: providerResponse,
      ttlSec: 300,
    });
    expect(store?.body).not.toHaveProperty("messages");
    expect(instance.getSemanticCacheStats()).toMatchObject({ misses: 1, sharedStores: 1 });
  });

  it("stays local without an embedding model name or a shared rule", async () => {
    const unnamed = await adapter({ embeddingModel: undefined });
    await unnamed.enforceRequest(
      request,
      jest.fn(async () => providerResponse),
      { provider: "openai" },
    );
    await unnamed.flush();

    rulesResponse = { ...rulesResponse, rules: [rule(false)] };
    const unshared = await adapter();
    await unshared.enforceRequest(
      request,
      jest.fn(async () => providerResponse),
      { provider: "openai" },
    );
    await unshared.flush();

    expect(paths().some((path) => path.startsWith("/v1/cache/semantic"))).toBe(false);
  });

  it("fails open on a slow lookup and stops after a refusal until the next rules poll", async () => {
    lookup = { status: 200, body: { hit: false }, delayMs: 600 };
    const onEnforcementError = jest.fn();
    const slow = await adapter({ onEnforcementError });
    const provider = jest.fn(async () => providerResponse);
    await slow.enforceRequest(request, provider, { provider: "openai" });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(slow.getSemanticCacheStats().sharedLookupFailures).toBe(1);
    expect(onEnforcementError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: "shared_semantic_cache_lookup" }),
    );

    // A timeout is not a refusal, so the slow instance still stored its answer.
    await slow.flush();
    expect(paths().filter((path) => path === "/v1/cache/semantic/store")).toHaveLength(1);

    calls = [];
    lookup = { status: 409, body: { error: "rule_not_shared" } };
    const refused = await adapter();
    await refused.enforceRequest(
      request,
      jest.fn(async () => providerResponse),
      { provider: "openai" },
    );
    await refused.flush();
    // A refused lookup suspends the shared cache: no store follows.
    expect(paths().filter((path) => path === "/v1/cache/semantic/store")).toHaveLength(0);
  });

  it("ignores settings with an unknown version", async () => {
    rulesResponse = { ...rulesResponse, sharedSemanticCache: { ...sharedSettings, version: "shared-semantic-v9" } };
    const instance = await adapter();
    await instance.enforceRequest(
      request,
      jest.fn(async () => providerResponse),
      { provider: "openai" },
    );
    await instance.flush();
    expect(paths().some((path) => path.startsWith("/v1/cache/semantic"))).toBe(false);
  });
});
