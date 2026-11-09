import * as http from "http";

import { CloudAdapter, TraiceEnforcementError, type ProviderCallOptions } from "../src/adapters/cloud";

describe("CloudAdapter load balancing across provider keys", () => {
  const request = { model: "gpt-4o-mini", messages: [{ role: "user", content: "Summarize this ticket" }] };
  const providerResponse = {
    object: "chat.completion",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 30, completion_tokens: 12 },
    choices: [{ message: { role: "assistant", content: "Done." } }],
  };
  const realNow = Date.now.bind(Date);

  let server: http.Server;
  let port: number;
  let rulesResponse: Record<string, unknown>;
  let acquireReplies: Array<Record<string, unknown>>;
  let calls: Array<{ path: string; body: any }>;
  let ruleHeaders: http.IncomingHttpHeaders[];
  let clockOffsetMs: number;

  function balance(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
    return {
      id: "rule_keys",
      name: "Spread OpenAI keys",
      state: "ACTIVE",
      priority: 1,
      condition: { type: "always" },
      action: "LOAD_BALANCE",
      actionParams: {
        keys: [
          { alias: "primary", weight: 50 },
          { alias: "secondary", weight: 30 },
          { alias: "overflow", weight: 20 },
        ],
        onRateLimit: "next_key",
        cooldownMs: 30_000,
        ...params,
      },
      requireEquivalencePct: null,
      modelAllowlist: [],
      ...overrides,
    };
  }
  function fallbackRule(actionParams: Record<string, unknown>) {
    return {
      id: "rule_fallback",
      name: "Fall back to gpt-4o",
      state: "ACTIVE",
      priority: 10,
      condition: { type: "always" },
      action: "FALLBACK",
      actionParams: { targetModel: "gpt-4o", backoffMs: 0, ...actionParams },
      requireEquivalencePct: null,
      modelAllowlist: [],
    };
  }
  const exactCacheRule = {
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
  const strictCap = {
    version: "strict-cap-v1",
    timeoutMs: 300,
    caps: [{ ruleId: "rule_cap", mode: "active", scope: "workspace", value: null, onUnavailable: "allow" }],
  };
  const capAllowed = { allowed: true, reservationIds: [], refused: null, shadowRefused: [] };
  const capRefused = {
    allowed: false,
    reservationIds: [],
    refused: { ruleId: "rule_cap", ruleName: "Workspace budget cap", limitUsd: 100, spentUsd: 99.99 },
    shadowRefused: [],
  };
  const rateLimited = (headers?: unknown) =>
    Object.assign(new Error("429 Rate limit reached for requests"), { status: 429, ...(headers ? { headers } : {}) });
  const serverError = () => Object.assign(new Error("500 The server had an error"), { status: 500 });

  beforeEach((done) => {
    rulesResponse = { ttlSeconds: 3600, rules: [balance()], loadBalance: { version: "load-balance-v1" } };
    acquireReplies = [];
    calls = [];
    ruleHeaders = [];
    clockOffsetMs = 0;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
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
        calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/v1/budget-caps/acquire") {
          res.end(JSON.stringify(acquireReplies.shift() ?? capAllowed));
          return;
        }
        res.end(JSON.stringify({ accepted: 1 }));
      });
    });
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    jest.restoreAllMocks();
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
  /** Math.random returns these values in order, then behaves normally. */
  function randomSequence(...values: number[]) {
    const spy = jest.spyOn(Math, "random");
    for (const value of values) spy.mockReturnValueOnce(value);
  }
  /** A provider callback that throws what `failures` returns for the key alias it gets, if anything. */
  function keyedProvider(failures: Record<string, () => unknown> = {}) {
    return jest.fn(async (effective: { model: string }, options?: ProviderCallOptions) => {
      const failure = options?.keyAlias ? failures[options.keyAlias]?.() : undefined;
      if (failure) throw failure;
      return { ...providerResponse, model: effective.model };
    });
  }
  const aliasesUsed = (provider: jest.Mock) =>
    provider.mock.calls.map((call) => (call[1] as ProviderCallOptions | undefined)?.keyAlias);
  const decisions = () => calls.filter((call) => call.path === "/v1/decisions").map((call) => call.body);
  const loadBalanceDecisions = () => decisions().filter((body) => body.action === "LOAD_BALANCE");
  const acquires = () => calls.filter((call) => call.path === "/v1/budget-caps/acquire");
  function decision(overrides: Record<string, unknown>) {
    return {
      ruleId: "rule_keys",
      action: "LOAD_BALANCE",
      mode: "active",
      requestedModel: "gpt-4o-mini",
      attempts: 1,
      switchedFrom: [],
      protocolVersion: 5,
      ...overrides,
    };
  }

  it("asks for protocol v5 and ignores load-balancing rules without the load-balance block", async () => {
    const instance = await adapter();
    expect(ruleHeaders[0]["x-traice-enforcement-version"]).toBe("5");
    randomSequence(0);
    const provider = keyedProvider();
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary"]);

    for (const block of [undefined, "load-balance-v1", { version: "load-balance-v2" }, { enabled: true }]) {
      rulesResponse = { ttlSeconds: 3600, rules: [balance()], ...(block === undefined ? {} : { loadBalance: block }) };
      const other = await adapter();
      const plain = keyedProvider();
      await expect(other.enforceRequest(request, plain)).resolves.toMatchObject({ model: "gpt-4o-mini" });
      expect(plain.mock.calls).toEqual([[request]]);
      await other.flush();
    }
    await instance.flush();
    expect(loadBalanceDecisions()).toHaveLength(1);
  });

  it("never lets a load-balancing rule stop a later cache rule", async () => {
    rulesResponse.rules = [balance(), exactCacheRule];
    const instance = await adapter();
    const provider = keyedProvider();
    randomSequence(0.6);
    await instance.enforceRequest(request, provider);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["secondary"]);
    await instance.flush();
    expect(decisions().map((body) => body.cacheOutcome ?? body.action)).toEqual(
      expect.arrayContaining(["miss", "LOAD_BALANCE", "hit"]),
    );
    expect(loadBalanceDecisions()).toEqual([decision({ keyAlias: "secondary", loadBalanceOutcome: "success" })]);
  });

  it("passes the picked key alias to the callback, in proportion to the weights", async () => {
    const instance = await adapter();
    const provider = keyedProvider();
    randomSequence(0, 0.49, 0.5, 0.79, 0.8, 0.999);
    for (let call = 0; call < 6; call++) {
      await instance.enforceRequest(request, provider, { feature: "support" });
    }
    expect(aliasesUsed(provider)).toEqual(["primary", "primary", "secondary", "secondary", "overflow", "overflow"]);
    expect(provider.mock.calls[0]).toEqual([request, { keyAlias: "primary" }]);
    expect(instance.getLoadBalanceStats()).toEqual({
      calls: 6,
      switches: 0,
      exhausted: 0,
      byAlias: { primary: 2, secondary: 2, overflow: 2 },
    });
    await instance.flush();
    expect(loadBalanceDecisions()).toHaveLength(6);
    expect(loadBalanceDecisions()[0]).toEqual(decision({ keyAlias: "primary", loadBalanceOutcome: "success" }));
  });

  it("moves to the next key after a provider rate limit and rests the limited key for the cooldown", async () => {
    const instance = await adapter();
    const provider = keyedProvider({ primary: () => rateLimited() });
    randomSequence(0, 0);
    await expect(instance.enforceRequest(request, provider)).resolves.toMatchObject({ model: "gpt-4o-mini" });
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary"]);

    // Within the 30 s cooldown, primary is left out and random 0 lands on secondary.
    clockOffsetMs = 29_000;
    randomSequence(0);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary", "secondary"]);

    // After the cooldown, primary is picked again.
    clockOffsetMs = 31_000;
    randomSequence(0, 0);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider).slice(3)).toEqual(["primary", "secondary"]);

    expect(instance.getLoadBalanceStats()).toEqual({
      calls: 3,
      switches: 2,
      exhausted: 0,
      byAlias: { secondary: 3 },
    });
    await instance.flush();
    expect(loadBalanceDecisions()[0]).toEqual(
      decision({ keyAlias: "secondary", attempts: 2, switchedFrom: ["primary"], loadBalanceOutcome: "success" }),
    );
    expect(loadBalanceDecisions()[1]).toEqual(decision({ keyAlias: "secondary", loadBalanceOutcome: "success" }));
  });

  it("rests a key for the provider's Retry-After, in seconds or as a date, held to 1 s..600 s", async () => {
    const instance = await adapter();
    let primaryFailure: (() => unknown) | undefined = () => rateLimited({ "retry-after": "5" });
    const provider = keyedProvider({ primary: () => primaryFailure?.() });
    const callAt = async (offsetMs: number, ...random: number[]) => {
      clockOffsetMs = offsetMs;
      randomSequence(...random);
      const before = provider.mock.calls.length;
      await instance.enforceRequest(request, provider);
      return aliasesUsed(provider).slice(before);
    };

    // Retry-After: 5 (seconds) instead of the rule's 30 s cooldown.
    expect(await callAt(0, 0, 0)).toEqual(["primary", "secondary"]);
    expect(await callAt(4_000, 0)).toEqual(["secondary"]);

    // An HTTP date two minutes out, on `response.headers` as a Headers object.
    primaryFailure = () =>
      Object.assign(new Error("Too Many Requests"), {
        statusCode: 429,
        response: { headers: new Headers({ "retry-after": new Date(Date.now() + 120_000).toUTCString() }) },
      });
    expect(await callAt(6_000, 0, 0)).toEqual(["primary", "secondary"]);
    expect(await callAt(100_000, 0)).toEqual(["secondary"]);

    // An hour is held to 600 s.
    primaryFailure = () => rateLimited({ "retry-after": "3600" });
    expect(await callAt(130_000, 0, 0)).toEqual(["primary", "secondary"]);
    expect(await callAt(720_000, 0)).toEqual(["secondary"]);
    primaryFailure = undefined;
    expect(await callAt(731_000, 0)).toEqual(["primary"]);
  });

  it("rethrows after one attempt when the rule does not switch keys, and still rests the key", async () => {
    rulesResponse.rules = [balance({}, { onRateLimit: "none" })];
    const instance = await adapter();
    const limit = rateLimited();
    const provider = keyedProvider({ primary: () => limit });
    randomSequence(0, 0);
    await expect(instance.enforceRequest(request, provider)).rejects.toBe(limit);
    expect(aliasesUsed(provider)).toEqual(["primary"]);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary"]);
    expect(instance.getLoadBalanceStats()).toMatchObject({ calls: 2, switches: 0, exhausted: 0 });
    await instance.flush();
    expect(loadBalanceDecisions()[0]).toEqual(
      decision({ keyAlias: "primary", loadBalanceOutcome: "failed", errorType: "429" }),
    );
  });

  it("reports a failed call and rethrows the provider error when every key is rate-limited", async () => {
    const instance = await adapter();
    const errors = {
      primary: rateLimited(),
      secondary: Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }),
      overflow: Object.assign(new Error("429"), { response: { status: 429 } }),
    };
    const provider = keyedProvider({
      primary: () => errors.primary,
      secondary: () => errors.secondary,
      overflow: () => errors.overflow,
    });
    randomSequence(0, 0, 0);
    await expect(instance.enforceRequest(request, provider)).rejects.toBe(errors.overflow);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary", "overflow"]);
    expect(instance.getLoadBalanceStats()).toEqual({
      calls: 1,
      switches: 2,
      exhausted: 1,
      byAlias: { overflow: 1 },
    });
    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([
      decision({
        keyAlias: "overflow",
        attempts: 3,
        switchedFrom: ["primary", "secondary"],
        loadBalanceOutcome: "failed",
        errorType: "429",
      }),
    ]);
  });

  it("does not switch keys on a server error and does not rest the key", async () => {
    const instance = await adapter();
    const failure = serverError();
    const provider = keyedProvider({ primary: () => failure });
    randomSequence(0, 0);
    await expect(instance.enforceRequest(request, provider)).rejects.toBe(failure);
    await expect(instance.enforceRequest(request, provider)).rejects.toBe(failure);
    expect(aliasesUsed(provider)).toEqual(["primary", "primary"]);
    await instance.flush();
    expect(loadBalanceDecisions()[0]).toEqual(
      decision({ keyAlias: "primary", loadBalanceOutcome: "failed", errorType: "5xx" }),
    );
  });

  it("checks strict caps before every attempt and never switches keys on a trAIce refusal", async () => {
    rulesResponse.strictCaps = strictCap;
    const instance = await adapter();
    const provider = keyedProvider({ primary: () => rateLimited() });

    // A switch is a second provider call, checked like the first.
    randomSequence(0, 0);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary"]);
    expect(acquires()).toHaveLength(2);

    // Refused before the first attempt: no provider call, no other key, no load-balancing decision.
    acquireReplies = [capRefused];
    randomSequence(0.6);
    await expect(instance.enforceRequest(request, provider)).rejects.toBeInstanceOf(TraiceEnforcementError);
    expect(provider).toHaveBeenCalledTimes(2);

    // Refused before the attempt on the next key: the refusal is thrown as is.
    clockOffsetMs = 40_000;
    acquireReplies = [capAllowed, capRefused];
    randomSequence(0, 0);
    const refused = await instance.enforceRequest(request, provider).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TraiceEnforcementError);
    expect(refused).toMatchObject({ action: "DENY", ruleId: "rule_cap" });
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary", "primary"]);

    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([
      decision({ keyAlias: "secondary", attempts: 2, switchedFrom: ["primary"], loadBalanceOutcome: "success" }),
      decision({
        keyAlias: "secondary",
        attempts: 1,
        switchedFrom: ["primary"],
        loadBalanceOutcome: "failed",
        errorType: "error",
      }),
    ]);
    expect(decisions().filter((body) => body.action === "DENY")).toHaveLength(2);
  });

  it("does not treat a TraiceEnforcementError from the callback as a rate limit", async () => {
    const instance = await adapter();
    const refusal = new TraiceEnforcementError("RATE_LIMIT", "rule_other", "Other limit", "gpt-4o-mini", {});
    const provider = keyedProvider({ primary: () => refusal });
    randomSequence(0, 0);
    await expect(instance.enforceRequest(request, provider)).rejects.toBe(refusal);
    expect(aliasesUsed(provider)).toEqual(["primary"]);
    await instance.enforceRequest(request, provider).catch(() => undefined);
    expect(aliasesUsed(provider)).toEqual(["primary", "primary"]);
  });

  it("calls the provider as without the rule for a rule in preview, and reports the key it would use", async () => {
    rulesResponse.rules = [balance({ state: "SHADOW" })];
    const instance = await adapter();
    const provider = keyedProvider();
    randomSequence(0.6);
    await instance.enforceRequest(request, provider);
    expect(provider.mock.calls).toEqual([[request]]);
    expect(instance.getLoadBalanceStats()).toEqual({ calls: 0, switches: 0, exhausted: 0, byAlias: {} });
    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([decision({ mode: "shadow", keyAlias: "secondary" })]);
  });

  it("balances the swapped model's request", async () => {
    rulesResponse.rules = [
      {
        id: "rule_swap",
        name: "Swap to mini",
        state: "ACTIVE",
        priority: 10,
        condition: { type: "always" },
        action: "SWAP",
        actionParams: { targetModel: "gpt-4o-mini" },
        requireEquivalencePct: 95,
        modelAllowlist: [],
      },
      balance({ condition: { type: "model", equals: "gpt-4o-mini" } }),
    ];
    rulesResponse.evidence = [
      {
        experimentId: "exp_mini",
        feature: "support",
        sourceModel: "gpt-4o",
        candidateModel: "gpt-4o-mini",
        equivalencePct: 98,
        sampleCount: 50,
      },
    ];
    const instance = await adapter();
    const provider = keyedProvider();
    randomSequence(0.9);
    await instance.enforceRequest({ ...request, model: "gpt-4o" }, provider, { feature: "support" });
    expect(provider.mock.calls[0]).toEqual([{ ...request, model: "gpt-4o-mini" }, { keyAlias: "overflow" }]);

    // Without the swap's evidence the call stays on gpt-4o, which the rule does not balance.
    await instance.enforceRequest({ ...request, model: "gpt-4o" }, provider, { feature: "billing" });
    expect(provider.mock.calls[1]).toEqual([{ ...request, model: "gpt-4o" }]);

    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([
      decision({ requestedModel: "gpt-4o-mini", keyAlias: "overflow", loadBalanceOutcome: "success" }),
    ]);
    expect(decisions()).toContainEqual(
      expect.objectContaining({ action: "SWAP", requestedModel: "gpt-4o", servedModel: "gpt-4o-mini" }),
    );
  });

  it("balances each retry and the fallback model of a fallback rule, passing the deadline signal through", async () => {
    rulesResponse.rules = [balance(), fallbackRule({ retryOn: ["5xx"], maxRetries: 1, timeoutMs: 5_000 })];
    const instance = await adapter();
    const provider = jest.fn(async (effective: { model: string }, options?: ProviderCallOptions) => {
      if (effective.model === "gpt-4o-mini") throw serverError();
      return { ...providerResponse, model: effective.model };
    });
    randomSequence(0, 0.6, 0.9);
    await expect(instance.enforceRequest(request, provider)).resolves.toMatchObject({ model: "gpt-4o" });
    expect(provider.mock.calls.map(([effective, options]) => [effective.model, options?.keyAlias])).toEqual([
      ["gpt-4o-mini", "primary"],
      ["gpt-4o-mini", "secondary"],
      ["gpt-4o", "overflow"],
    ]);
    for (const [, options] of provider.mock.calls) expect(options?.signal).toBeInstanceOf(AbortSignal);
    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([
      decision({ keyAlias: "primary", loadBalanceOutcome: "failed", errorType: "5xx" }),
      decision({ keyAlias: "secondary", loadBalanceOutcome: "failed", errorType: "5xx" }),
      decision({ requestedModel: "gpt-4o", keyAlias: "overflow", loadBalanceOutcome: "success" }),
    ]);
    expect(decisions()).toContainEqual(
      expect.objectContaining({ action: "FALLBACK", fallbackOutcome: "success", servedModel: "gpt-4o" }),
    );
  });

  it("starts no attempt on another key once the call's deadline has passed", async () => {
    rulesResponse.rules = [balance(), fallbackRule({ retryOn: ["timeout"], timeoutMs: 50 })];
    const instance = await adapter();
    const provider = jest.fn(async (effective: { model: string }, options?: ProviderCallOptions) => {
      if (effective.model === "gpt-4o-mini") {
        // The provider answers 429 just after the deadline aborted the call.
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
        throw rateLimited();
      }
      return { ...providerResponse, model: effective.model };
    });
    randomSequence(0, 0.6);
    await expect(instance.enforceRequest(request, provider)).resolves.toMatchObject({ model: "gpt-4o" });
    await instance.flush();
    expect(provider.mock.calls.filter(([effective]) => effective.model === "gpt-4o-mini")).toHaveLength(1);
    expect(loadBalanceDecisions()).toContainEqual(
      decision({ keyAlias: "primary", loadBalanceOutcome: "failed", errorType: "429" }),
    );
  });

  it("passes the key alias to a Bedrock Converse callback", async () => {
    const instance = await adapter();
    const converse = {
      output: { message: { role: "assistant", content: [{ text: "Done." }] } },
      usage: { inputTokens: 30, outputTokens: 12 },
      stopReason: "end_turn",
    };
    const provider = jest.fn(async (input: { modelId: string }, options?: ProviderCallOptions) => converse);
    const input = { modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", messages: [] };
    randomSequence(0.9);
    await expect(instance.enforceBedrockRequest(input, provider)).resolves.toBe(converse);
    expect(provider.mock.calls).toEqual([[input, { keyAlias: "overflow" }]]);
    await instance.flush();
    expect(loadBalanceDecisions()).toEqual([
      decision({ requestedModel: input.modelId, keyAlias: "overflow", loadBalanceOutcome: "success" }),
    ]);
  });

  it("starts the rest over when a rules refresh changes the rule's keys", async () => {
    rulesResponse.ttlSeconds = 1;
    const instance = await adapter();
    let primaryLimited = true;
    const provider = keyedProvider({ primary: () => (primaryLimited ? rateLimited() : undefined) });
    randomSequence(0, 0);
    await instance.enforceRequest(request, provider);
    primaryLimited = false;

    // The same keys after a refresh: primary keeps resting.
    clockOffsetMs = 2_000;
    await instance.warmEnforcement();
    randomSequence(0);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary", "secondary"]);

    // Other keys: the rest starts over.
    rulesResponse.rules = [
      balance(
        {},
        {
          keys: [
            { alias: "primary", weight: 50 },
            { alias: "reserve", weight: 50 },
          ],
        },
      ),
    ];
    clockOffsetMs = 4_000;
    await instance.warmEnforcement();
    randomSequence(0);
    await instance.enforceRequest(request, provider);
    expect(aliasesUsed(provider)).toEqual(["primary", "secondary", "secondary", "primary"]);
    expect(ruleHeaders).toHaveLength(3);
  });

  it("calls the provider as if no rule matched when load balancing itself fails", async () => {
    const onEnforcementError = jest.fn();
    const instance = await adapter(onEnforcementError);
    jest.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("no randomness");
    });
    const provider = keyedProvider();
    await expect(instance.enforceRequest(request, provider)).resolves.toMatchObject({ model: "gpt-4o-mini" });
    expect(provider.mock.calls).toEqual([[request]]);
    expect(onEnforcementError).toHaveBeenCalledWith(expect.objectContaining({ message: "no randomness" }), {
      operation: "load_balance",
    });
    expect(instance.getEnforcementStats().failOpenRequests).toBe(1);
  });
});
