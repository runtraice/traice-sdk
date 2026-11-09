import * as http from "http";

import { CloudAdapter, TraiceEnforcementError } from "../src/adapters/cloud";
import type { CostEvent } from "../src/types";

describe("CloudAdapter strict budget caps", () => {
  // 9 + 21 characters of message text: an estimate of 8 input tokens.
  const request = {
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: [{ type: "text", text: "Summarize this ticket" }] },
    ],
    max_tokens: 256,
  };
  const providerResponse = {
    object: "chat.completion",
    model: "gpt-4o-mini",
    usage: { prompt_tokens: 30, completion_tokens: 12 },
    choices: [{ message: { role: "assistant", content: "Done." } }],
  };

  let server: http.Server;
  let port: number;
  let rulesResponse: Record<string, unknown>;
  let acquire: { status: number; body: Record<string, unknown>; delayMs?: number };
  let calls: Array<{ path: string; body: any }>;
  let ruleHeaders: http.IncomingHttpHeaders[];

  function cap(overrides: Record<string, unknown> = {}) {
    return {
      ruleId: "rule_cap",
      mode: "active",
      scope: "workspace",
      value: null,
      onUnavailable: "allow",
      ...overrides,
    };
  }
  function strictCaps(caps: unknown[], timeoutMs = 300) {
    return { version: "strict-cap-v1", timeoutMs, caps };
  }
  const allowed = (reservationIds: string[] = ["res_1"], shadowRefused: string[] = []) => ({
    allowed: true,
    reservationIds,
    refused: null,
    shadowRefused,
    estimateUsd: 0.0002,
  });
  const refusal = {
    allowed: false,
    reservationIds: [],
    refused: {
      ruleId: "rule_cap",
      ruleName: "Workspace budget cap",
      budgetId: "budget_1",
      budgetName: "Monthly workspace",
      limitUsd: 100,
      spentUsd: 99.9,
      reservedUsd: 0.25,
      estimateUsd: 0.0002,
    },
    shadowRefused: [],
    estimateUsd: 0.0002,
  };
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

  function event(overrides: Partial<CostEvent> = {}): CostEvent {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      timestamp: "2026-11-08T10:00:00Z",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      inputCostUSD: 0.0001,
      outputCostUSD: 0.0001,
      totalCostUSD: 0.0002,
      latencyMs: 120,
      feature: "support",
      ...overrides,
    };
  }

  beforeEach((done) => {
    rulesResponse = { ttlSeconds: 60, rules: [], strictCaps: strictCaps([cap()]) };
    acquire = { status: 200, body: allowed() };
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
        calls.push({ path: req.url ?? "", body: raw ? JSON.parse(raw) : null });
        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.url === "/v1/budget-caps/acquire") {
          setTimeout(() => reply(acquire.status, acquire.body), acquire.delayMs ?? 0);
          return;
        }
        if (req.url === "/v1/rate-limits/acquire") return reply(200, { allowed: true, shadowLimited: [] });
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

  async function adapter() {
    const instance = new CloudAdapter({ apiKey: "workspace-key", endpoint: `http://localhost:${port}/v1/events` });
    await instance.warmEnforcement();
    return instance;
  }
  const acquires = () => calls.filter((call) => call.path === "/v1/budget-caps/acquire");
  const decisions = () => calls.filter((call) => call.path === "/v1/decisions");
  const sentEvents = () =>
    calls.filter((call) => call.path === "/v1/events").flatMap((call) => call.body.events as any[]);

  it("asks for a protocol with strict caps and ignores a missing or malformed strict cap block", async () => {
    const instance = await adapter();
    expect(Number(ruleHeaders[0]["x-traice-enforcement-version"])).toBeGreaterThanOrEqual(4);
    await instance.enforceRequest(request, async () => providerResponse);
    expect(acquires()).toHaveLength(1);

    for (const malformed of [
      undefined,
      "strict",
      { version: "strict-cap-v0", timeoutMs: 300, caps: [cap()] },
      { version: "strict-cap-v1", timeoutMs: 300, caps: "all" },
      strictCaps([{ ruleId: "", mode: "active", scope: "workspace", value: null, onUnavailable: "block" }]),
      strictCaps([{ ruleId: "rule_cap", mode: "enforcing", scope: "workspace", value: null, onUnavailable: "block" }]),
    ]) {
      rulesResponse = { ttlSeconds: 60, rules: [], ...(malformed === undefined ? {} : { strictCaps: malformed }) };
      const other = await adapter();
      await expect(other.enforceRequest(request, async () => providerResponse)).resolves.toBe(providerResponse);
    }
    expect(acquires()).toHaveLength(1);
  });

  it("checks a matching cap before each provider call and settles it with the call's event", async () => {
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await expect(
      instance.enforceRequest(request, provider, { feature: "support", userId: "u-1", provider: "openai" }),
    ).resolves.toBe(providerResponse);

    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledWith(request);
    expect(acquires()).toHaveLength(1);
    expect(acquires()[0].body).toEqual({
      ruleIds: ["rule_cap"],
      feature: "support",
      userId: "u-1",
      model: "gpt-4o-mini",
      provider: "openai",
      inputTokens: 8,
      maxOutputTokens: 256,
    });

    await instance.write(event({ id: "evt-other", feature: "billing" }));
    await instance.write(event({ id: "evt-support" }));
    await instance.write(event({ id: "evt-later" }));
    await instance.flush();
    const byId = new Map(sentEvents().map((sent) => [sent.externalId, sent]));
    expect(byId.get("evt-other")).not.toHaveProperty("capReservationIds");
    expect(byId.get("evt-support")?.capReservationIds).toEqual(["res_1"]);
    expect(byId.get("evt-later")).not.toHaveProperty("capReservationIds");
  });

  it("settles the reservation of an event that names the model the provider reported", async () => {
    const instance = await adapter();
    await instance.enforceRequest(request, async () => ({ ...providerResponse, model: "gpt-4o-mini-2024-07-18" }));
    await instance.write(event({ id: "evt-dated", model: "gpt-4o-mini-2024-07-18", feature: undefined }));
    await instance.flush();
    expect(sentEvents()[0].capReservationIds).toEqual(["res_1"]);
  });

  it("keeps no reservation for a call that fails, or for an error event", async () => {
    const instance = await adapter();
    const failure = new Error("provider down");
    await expect(
      instance.enforceRequest(request, async () => Promise.reject(failure), { feature: "support" }),
    ).rejects.toBe(failure);
    await instance.write(event({ id: "evt-after-failure" }));

    await instance.enforceRequest(request, async () => providerResponse, { feature: "support" });
    await instance.write(event({ id: "evt-error", status: "error" }));
    await instance.write(event({ id: "evt-success" }));
    await instance.flush();
    const byId = new Map(sentEvents().map((sent) => [sent.externalId, sent]));
    expect(byId.get("evt-after-failure")).not.toHaveProperty("capReservationIds");
    expect(byId.get("evt-error")).not.toHaveProperty("capReservationIds");
    expect(byId.get("evt-success")?.capReservationIds).toEqual(["res_1"]);
  });

  it("refuses with a DENY error, does not call the provider, and posts the blocking decision", async () => {
    acquire = { status: 200, body: refusal };
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    const refused = await instance
      .enforceRequest(request, provider, { feature: "support" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(TraiceEnforcementError);
    expect(refused).toMatchObject({
      code: "TRAICE_REQUEST_BLOCKED",
      action: "DENY",
      ruleId: "rule_cap",
      ruleName: "Workspace budget cap",
      requestedModel: "gpt-4o-mini",
      reason: {
        type: "budget_cap",
        strictCap: true,
        budgetId: "budget_1",
        limitUsd: 100,
        spentUsd: 99.9,
        reservedUsd: 0.25,
      },
    });
    expect((refused as TraiceEnforcementError).message).toBe("Request denied by trAIce rule: Workspace budget cap");
    expect(provider).not.toHaveBeenCalled();
    await instance.flush();
    expect(decisions()).toHaveLength(1);
    expect(decisions()[0].body).toMatchObject({
      ruleId: "rule_cap",
      action: "DENY",
      requestedModel: "gpt-4o-mini",
      reason: { strictCap: true },
    });
  });

  it("never sends a refusal to a fallback rule", async () => {
    acquire = { status: 200, body: refusal };
    rulesResponse.rules = [
      {
        id: "rule_fallback",
        name: "Fall back",
        state: "ACTIVE",
        priority: 10,
        condition: { type: "always" },
        action: "FALLBACK",
        actionParams: { targetModel: "gpt-4o", maxRetries: 2, backoffMs: 0 },
        requireEquivalencePct: null,
        modelAllowlist: [],
      },
    ];
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await expect(instance.enforceRequest(request, provider)).rejects.toMatchObject({ action: "DENY" });
    expect(provider).not.toHaveBeenCalled();
    expect(acquires()).toHaveLength(1);
  });

  it("lets the call through when trAIce is slow or failing, unless an active cap blocks", async () => {
    rulesResponse.strictCaps = strictCaps([cap()], 50);
    const open = await adapter();
    const provider = jest.fn(async () => providerResponse);
    acquire = { status: 200, body: refusal, delayMs: 300 };
    await expect(open.enforceRequest(request, provider)).resolves.toBe(providerResponse);
    acquire = { status: 500, body: { error: "internal" } };
    await expect(open.enforceRequest(request, provider)).resolves.toBe(providerResponse);
    expect(provider).toHaveBeenCalledTimes(2);

    rulesResponse.strictCaps = strictCaps(
      [cap(), cap({ ruleId: "rule_user", scope: "user", value: "u-1", onUnavailable: "block" })],
      50,
    );
    const blocking = await adapter();
    const blocked = jest.fn(async () => providerResponse);
    for (const failure of [
      { status: 200, body: allowed(), delayMs: 300 },
      { status: 500, body: { error: "internal" } },
    ]) {
      acquire = failure;
      const error = await blocking
        .enforceRequest(request, blocked, { userId: "u-1" })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(TraiceEnforcementError);
      expect(error).toMatchObject({ action: "DENY", ruleId: "rule_user", reason: { unavailable: true } });
      expect((error as Error).message).toContain("could not confirm the budget");
    }
    expect(blocked).not.toHaveBeenCalled();
    // The user cap does not apply to another user, so only the workspace cap (allow) is checked.
    await expect(blocking.enforceRequest(request, blocked, { userId: "u-2" })).resolves.toBe(providerResponse);
  });

  it("never blocks on a cap in preview", async () => {
    rulesResponse.strictCaps = strictCaps([cap({ mode: "shadow", onUnavailable: "block" })], 50);
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    acquire = { status: 200, body: allowed([]), delayMs: 300 };
    await expect(instance.enforceRequest(request, provider)).resolves.toBe(providerResponse);
    acquire = { status: 503, body: { error: "unavailable" } };
    await expect(instance.enforceRequest(request, provider)).resolves.toBe(providerResponse);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("makes no check for a cache hit", async () => {
    rulesResponse.rules = [exactCacheRule];
    const instance = await adapter();
    const provider = jest.fn(async () => providerResponse);
    await instance.enforceRequest(request, provider);
    await instance.enforceRequest(request, provider);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(acquires()).toHaveLength(1);
  });

  it("checks after the rate limit, right before the provider call", async () => {
    rulesResponse.rules = [
      {
        id: "rule_rpm",
        name: "Requests per minute",
        state: "ACTIVE",
        priority: 1,
        condition: { type: "always" },
        action: "RATE_LIMIT",
        actionParams: { requestsPerMinute: 600, per: "api_key" },
        requireEquivalencePct: null,
        modelAllowlist: [],
      },
    ];
    rulesResponse.rateLimit = { version: "rate-limit-v1", timeoutMs: 150 };
    const instance = await adapter();
    await instance.enforceRequest(request, async () => {
      calls.push({ path: "provider", body: null });
      return providerResponse;
    });
    expect(calls.map((call) => call.path)).toEqual(["/v1/rate-limits/acquire", "/v1/budget-caps/acquire", "provider"]);
  });

  it("makes no check without matching strict caps", async () => {
    rulesResponse.strictCaps = strictCaps([]);
    const empty = await adapter();
    await empty.enforceRequest(request, async () => providerResponse, { feature: "support" });

    rulesResponse.strictCaps = strictCaps([
      cap({ scope: "feature", value: "billing" }),
      cap({ ruleId: "rule_user", scope: "user", value: "u-9" }),
      cap({ ruleId: "rule_tenant", scope: "tenant", value: "acme" }),
    ]);
    const unmatched = await adapter();
    await unmatched.enforceRequest(request, async () => providerResponse, { feature: "support", userId: "u-1" });
    expect(acquires()).toHaveLength(0);
  });

  it("counts checks, refusals, unavailable checks and previews", async () => {
    rulesResponse.strictCaps = strictCaps([
      cap(),
      cap({ ruleId: "rule_key", scope: "api_key", onUnavailable: "block" }),
    ]);
    const instance = await adapter();
    const provider = async () => providerResponse;
    acquire = { status: 200, body: allowed(["res_1", "res_2"], ["rule_preview"]) };
    await instance.enforceRequest(request, provider);
    acquire = { status: 200, body: refusal };
    await instance.enforceRequest(request, provider).catch(() => undefined);
    acquire = { status: 500, body: { error: "internal" } };
    await instance.enforceRequest(request, provider).catch(() => undefined);
    expect(instance.getStrictCapStats()).toEqual({
      checked: 2,
      refused: 1,
      unavailable: 1,
      blockedUnavailable: 1,
      shadowRefused: 1,
    });
    expect(acquires()[0].body.ruleIds).toEqual(["rule_cap", "rule_key"]);
  });
});
