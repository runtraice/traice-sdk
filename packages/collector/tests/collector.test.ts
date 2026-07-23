import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InternalUsageEvent } from "@traice/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAndStoreCollectorAuthorization } from "../src/auth";
import { defaultSourceForAgent } from "../src/config";
import { backfillCodex, dryRunCodexBackfill } from "../src/backfill";
import { readCollectorCredential, storeCollectorCredential } from "../src/credentials";
import { installAgent } from "../src/install";
import { normalizeClaudeCodeOtlpLogs, normalizeClaudeCodeOtlpMetrics } from "../src/adapters/claude-code";
import { normalizeCodexOtlpLogs } from "../src/adapters/codex";
import { CollectorOutbox } from "../src/outbox";
import { createSerializedEventForwarder, forwardEvents, normalizePayloadForRequest } from "../src/run";
import { installCollectorService } from "../src/service";
import { setupAgent } from "../src/setup";
import { codexTomlBlock } from "../src/settings";
import { formatCollectorStatus, getCollectorServiceStatus, getCollectorStatus } from "../src/status";
import type { CollectorConfig } from "../src/types";

const identity = {
  employeeEmail: "alex@example.com",
  employeeName: "Alex",
  teamName: "Engineering",
  sourcePrincipal: "host:user",
};
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("@traice/collector", () => {
  it("normalizes Claude Code OTLP log token records", () => {
    const events = normalizeClaudeCodeOtlpLogs(logPayload("claude", "claude-3-5-sonnet", 12, 8), {
      source: defaultSourceForAgent("claude-code"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceKey: "claude-code-local",
      tool: "claude-code",
      employeeEmail: "alex@example.com",
      model: "claude-3-5-sonnet",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
    expect(events[0]?.metadata).not.toHaveProperty("body");
  });

  it("only includes OTLP bodies after explicit prompt capture opt-in", () => {
    const events = normalizeClaudeCodeOtlpLogs(logPayload("claude", "claude-3-5-sonnet", 12, 8), {
      source: defaultSourceForAgent("claude-code"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
      includePrompts: true,
    });

    expect(events[0]?.metadata).toMatchObject({ body: "response.completed" });
  });

  it("extracts reported cost and latency into first-class fields", () => {
    const payload = logPayload("codex", "gpt-5-codex", 7, 2);
    const attributes = (payload.resourceLogs[0].scopeLogs[0].logRecords[0] as any).attributes;
    attributes.push({ key: "cost_usd", value: { doubleValue: 0.42 } });
    attributes.push({ key: "duration_ms", value: { intValue: "875" } });
    const [event] = normalizeCodexOtlpLogs(payload, {
      source: defaultSourceForAgent("codex"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(event).toMatchObject({ costUsd: 0.42, costBasis: "reported", latencyMs: 875 });
  });

  it("normalizes Claude Code OTLP metric token points", () => {
    const events = normalizeClaudeCodeOtlpMetrics(metricPayload("gen_ai.client.token.usage.input", 42), {
      source: defaultSourceForAgent("claude-code"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.inputTokens).toBe(42);
  });

  it("normalizes Codex OTLP logs through the same protocol", () => {
    const events = normalizeCodexOtlpLogs(logPayload("codex", "gpt-5-codex", 7, 2), {
      source: defaultSourceForAgent("codex"),
      identity,
      receivedAt: "2026-07-10T00:00:00.000Z",
    });

    expect(events[0]).toMatchObject({
      sourceKey: "codex-local",
      tool: "codex",
      model: "gpt-5-codex",
      totalTokens: 9,
    });
  });

  it("normalizes token attributes emitted by current Codex builds", () => {
    const events = normalizeCodexOtlpLogs(currentCodexLogPayload(), {
      source: defaultSourceForAgent("codex"),
      identity,
      receivedAt: "2026-07-18T00:00:00.000Z",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceKey: "codex-local",
      tool: "codex",
      occurredAt: "2026-07-18T14:33:35.712Z",
      model: "gpt-5.4",
      runId: "conversation-1",
      inputTokens: 16_151,
      outputTokens: 23,
      cacheReadTokens: 2_432,
      totalTokens: 16_174,
    });
  });

  it("generates a Codex-compatible OTLP HTTP exporter block", () => {
    const block = codexTomlBlock({ listenHost: "127.0.0.1", listenPort: 4318, includePrompts: false });

    expect(block).toContain(
      'exporter = { otlp-http = { endpoint = "http://127.0.0.1:4318/v1/logs", protocol = "json" } }',
    );
    expect(block).not.toContain("otlp =");
  });

  it("dry-runs a bounded Codex backfill without reading transcript content into the result", () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-codex-backfill-"));
    temporaryDirectories.push(directory);
    const sessions = join(directory, "sessions", "2026", "07", "10");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "rollout.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
        JSON.stringify({
          timestamp: "2026-07-09T23:59:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { last_token_usage: { total_tokens: 99 } } },
        }),
        JSON.stringify({
          timestamp: "2026-07-10T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 4,
                output_tokens: 3,
                reasoning_output_tokens: 2,
                total_tokens: 13,
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 4,
                output_tokens: 3,
                reasoning_output_tokens: 2,
                total_tokens: 13,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-10T12:00:00.500Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 4,
                output_tokens: 3,
                reasoning_output_tokens: 2,
                total_tokens: 13,
              },
              last_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 4,
                output_tokens: 3,
                reasoning_output_tokens: 2,
                total_tokens: 13,
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-10T12:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "must not appear" },
        }),
      ].join("\n"),
    );

    const result = dryRunCodexBackfill({
      codexHome: directory,
      since: "2026-07-10T00:00:00.000Z",
      until: "2026-07-11T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      dryRun: true,
      sendsData: false,
      filesDiscovered: 1,
      filesWithUsage: 1,
      sessionsWithUsage: 1,
      usageEvents: 1,
      duplicateEventIds: 0,
      repeatedSnapshotsSkipped: 1,
      tokens: { input: 10, cachedInput: 4, output: 3, reasoningOutput: 2, total: 13 },
    });
    expect(JSON.stringify(result)).not.toContain("must not appear");
  });

  it("skips matching live events before uploading a bounded Codex backfill", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-codex-backfill-upload-"));
    temporaryDirectories.push(directory);
    const sessions = join(directory, "codex", "sessions", "2026", "07", "10");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "rollout.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.4" } }),
        JSON.stringify({
          timestamp: "2026-07-10T12:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, total_tokens: 13 },
              last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, total_tokens: 13 },
            },
          },
        }),
      ].join("\n"),
    );
    const configPath = join(directory, "collector.json");
    writeFileSync(configPath, JSON.stringify({ ...collectorConfig(), serverUrl: "https://example.test" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        usage: [
          {
            occurredAt: "2026-07-10T11:59:59.500Z",
            runId: "session-1",
            model: "gpt-5.4",
            inputTokens: 10,
            cacheReadTokens: 4,
            outputTokens: 3,
            totalTokens: 13,
            metadata: { eventName: "codex.sse_event" },
          },
        ],
      }),
    );

    const result = await backfillCodex({
      configPath,
      codexHome: join(directory, "codex"),
      since: "2026-07-10T00:00:00.000Z",
      now: new Date("2026-07-11T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      usageEvents: 1,
      liveEventsInspected: 1,
      crossModeDuplicatesSkipped: 1,
      uploadCandidates: 0,
      accepted: 0,
      dropped: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("does not duplicate ambiguous payloads when multiple agents are enabled", () => {
    const config: CollectorConfig = {
      version: 1,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
      serverUrl: "https://runtraice.com",
      listenHost: "127.0.0.1",
      listenPort: 4318,
      includePrompts: false,
      enabledAgents: ["claude-code", "codex"],
      identity,
      sources: {
        "claude-code": defaultSourceForAgent("claude-code"),
        codex: defaultSourceForAgent("codex"),
      },
    };

    expect(
      normalizePayloadForRequest("/v1/logs", logPayload("unknown", "model", 1, 1), config, undefined, config.createdAt),
    ).toEqual([]);
    expect(
      normalizePayloadForRequest("/v1/logs", logPayload("codex", "model", 1, 1), config, undefined, config.createdAt),
    ).toHaveLength(1);
  });

  it("forwards large payloads in bounded batches", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      return Response.json({ accepted: body.events.length });
    });

    const onBatch = vi.fn();
    const sent = await forwardEvents(
      collectorConfig(),
      Array.from({ length: 23 }, (_, i) => usageEvent(i)),
      {
        fetchImpl,
        batchSize: 10,
        onBatch,
      },
    );

    expect(sent).toBe(23);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events.length)).toEqual([10, 10, 3]);
    expect(onBatch.mock.calls.map(([progress]) => progress)).toEqual([
      { processed: 10, total: 23, accepted: 10 },
      { processed: 20, total: 23, accepted: 20 },
      { processed: 23, total: 23, accepted: 23 },
    ]);
  });

  it("retries transient downstream failures with exponential backoff", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ accepted: 1 }));
    const sleep = vi.fn(async () => undefined);

    await expect(
      forwardEvents(collectorConfig(), [usageEvent(1)], {
        fetchImpl,
        sleep,
        maxAttempts: 3,
        random: () => 0.5,
      }),
    ).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("honors rate-limit retry guidance and caps the delay", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "Retry-After": "30" } }))
      .mockResolvedValueOnce(Response.json({ accepted: 1 }));
    const sleep = vi.fn(async () => undefined);

    await forwardEvents(collectorConfig(), [usageEvent(1)], {
      fetchImpl,
      sleep,
      maxAttempts: 2,
      maxRetryDelayMs: 500,
    });

    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("persists, bounds, reloads, and acknowledges the durable outbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-outbox-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state", "outbox.ndjson");
    const outbox = new CollectorOutbox(path, 2);
    await outbox.initialize();

    expect(await outbox.enqueue([usageEvent(1), usageEvent(2), usageEvent(3)])).toEqual({
      queued: 2,
      deduplicated: 0,
      dropped: 1,
    });
    expect(outbox.stats()).toMatchObject({ queued: 2, overflowDropped: 1 });

    const restored = new CollectorOutbox(path, 2);
    await restored.initialize();
    expect((await restored.peek(10)).map((event) => event.sourceEventId)).toEqual(["event-2", "event-3"]);
    expect(await restored.enqueue([usageEvent(3)])).toMatchObject({ deduplicated: 1, queued: 0 });
    await restored.acknowledge(["event-2", "event-3"]);
    expect(restored.stats()).toMatchObject({ queued: 0, delivered: 2 });
  });

  it("serializes concurrent forwarding requests", async () => {
    let releaseFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (fetchImpl.mock.calls.length === 1) await firstResponse;
      active -= 1;
      return Response.json({ accepted: 1 });
    });
    const enqueue = createSerializedEventForwarder({ fetchImpl });

    const first = enqueue(collectorConfig(), [usageEvent(1)]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = enqueue(collectorConfig(), [usageEvent(2)]);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(maxActive).toBe(1);
  });

  it("stores credentials through an OS keyring reference without writing the secret to config", async () => {
    const passwords = new Map<string, string>();
    const dependencies = {
      createKeyringEntry: (service: string, account: string) => ({
        setPassword: async (password: string) => {
          passwords.set(`${service}:${account}`, password);
        },
        getPassword: async () => passwords.get(`${service}:${account}`),
      }),
    };
    const result = await storeCollectorCredential(
      "/tmp/traice-test/config.json",
      "secret-value",
      "keyring",
      dependencies,
    );

    expect(result.credential.backend).toBe("os-keyring");
    expect(await readCollectorCredential(result.credential, dependencies)).toBe("secret-value");
    expect(JSON.stringify(result.credential)).not.toContain("secret-value");
  });

  it("recovers when a native keyring requires deleting an existing item before replacement", async () => {
    let value = "old-secret";
    let firstWrite = true;
    const setPassword = vi.fn(async (next: string) => {
      if (firstWrite) {
        firstWrite = false;
        throw new Error("The specified item already exists in the keychain.");
      }
      value = next;
    });
    const deletePassword = vi.fn(async () => {
      value = "";
    });

    const result = await storeCollectorCredential("/tmp/traice-keyring-replace/config.json", "new-secret", "keyring", {
      createKeyringEntry: () => ({
        setPassword,
        getPassword: async () => value || undefined,
        deletePassword,
      }),
    });

    expect(result.credential.backend).toBe("os-keyring");
    expect(deletePassword).toHaveBeenCalledOnce();
    expect(setPassword).toHaveBeenCalledTimes(2);
    expect(value).toBe("new-secret");
  });

  it("uses a protected-file fallback without keeping the key in collector config", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-credentials-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      apiKey: "lm_live_test_secret",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });

    const configText = readFileSync(configPath, "utf8");
    const config = JSON.parse(configText) as CollectorConfig;
    expect(configText).not.toContain("lm_live_test_secret");
    expect(config.credential?.backend).toBe("protected-file");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(await readCollectorCredential(config.credential!)).toBe("lm_live_test_secret");
  });

  it("writes a macOS LaunchAgent with absolute runtime paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-service-"));
    temporaryDirectories.push(directory);
    const commands: Array<{ command: string; args: string[]; ignoreFailure?: boolean }> = [];

    const result = installCollectorService(
      { agent: "codex", configPath: join(directory, "config.json"), packageVersion: "0.2.5" },
      {
        platform: "darwin",
        home: directory,
        uid: 501,
        prepareRuntime: () => ({ nodePath: "/absolute/node", cliPath: "/absolute/collector-cli.cjs" }),
        run: (command, args, ignoreFailure) => commands.push({ command, args, ignoreFailure }),
      },
    );

    const plist = readFileSync(result.definitionPath, "utf8");
    expect(plist).toContain("<string>/absolute/node</string>");
    expect(plist).toContain("<string>/absolute/collector-cli.cjs</string>");
    expect(plist).toContain(`<string>${join(directory, "config.json")}</string>`);
    expect(commands).toEqual([
      {
        command: "launchctl",
        args: ["bootout", "gui/501", result.definitionPath],
        ignoreFailure: true,
      },
      { command: "launchctl", args: ["bootstrap", "gui/501", result.definitionPath], ignoreFailure: undefined },
      {
        command: "launchctl",
        args: ["kickstart", "-k", "gui/501/com.traice.collector"],
        ignoreFailure: undefined,
      },
    ]);
  });

  it("installs a hidden per-user Windows startup launcher without requiring Task Scheduler", () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-windows-service-"));
    temporaryDirectories.push(directory);
    const appData = join(directory, "AppData", "Roaming");
    const configPath = join(directory, ".traice", "collector", "config.json");
    const commands: Array<{ command: string; args: string[]; ignoreFailure?: boolean }> = [];

    const result = installCollectorService(
      { agent: "codex", configPath, packageVersion: "0.2.8" },
      {
        platform: "win32",
        home: directory,
        appData,
        prepareRuntime: () => ({
          nodePath: "C:\\Program Files\\nodejs\\node.exe",
          cliPath: join(directory, ".traice", "collector", "runtime", "cli.cjs"),
        }),
        run: (command, args, ignoreFailure) => commands.push({ command, args, ignoreFailure }),
      },
    );

    const commandPath = join(directory, ".traice", "collector", "service", "traice-collector.cmd");
    const command = readFileSync(commandPath, "utf8");
    const launcher = readFileSync(result.definitionPath, "utf8");
    expect(command).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(command).toContain(":restart");
    expect(command).toContain("timeout /t 5 /nobreak");
    expect(command).not.toContain("apiKey");
    expect(launcher).toContain("WScript.Shell");
    expect(launcher).toContain(commandPath);
    expect(commands).toEqual([
      { command: "schtasks.exe", args: ["/End", "/TN", "trAIce Collector"], ignoreFailure: true },
      {
        command: "schtasks.exe",
        args: ["/Delete", "/TN", "trAIce Collector", "/F"],
        ignoreFailure: true,
      },
      { command: "wscript.exe", args: [result.definitionPath], ignoreFailure: undefined },
    ]);
    expect(
      getCollectorServiceStatus({
        platform: "win32",
        home: directory,
        appData,
        run: () => {
          throw new Error("Task Scheduler should not be queried");
        },
      }),
    ).toMatchObject({ ok: true, state: "installed", definitionPath: result.definitionPath });
  });

  it("reuses a valid persisted credential without prompting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-setup-reuse-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      serverUrl: "https://runtraice.com",
      apiKey: "persisted-key",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });
    const promptSecret = vi.fn(async () => {
      throw new Error("prompt should not run");
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer persisted-key");
      return Response.json({ usage: [] });
    });

    const result = await setupAgent(
      { agent: "codex", configPath, service: false, backfill: false, codexHome: join(directory, "codex") },
      { fetchImpl, promptSecret },
    );

    expect(result.connection.ok).toBe(true);
    expect(promptSecret).not.toHaveBeenCalled();
  });

  it("replaces a persisted API key rejected by the server with browser authorization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-setup-replace-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      serverUrl: "https://runtraice.com",
      apiKey: "expired-key",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });
    const promptSecret = vi.fn(async () => {
      throw new Error("API key prompt should not run");
    });
    const report = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid_api_key" }, { status: 401 }))
      .mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tr_oauth_at_secret");
        return Response.json({ usage: [] });
      });
    const login = successfulBrowserLogin();

    await setupAgent(
      {
        agent: "codex",
        configPath,
        service: false,
        backfill: false,
        credentialStore: "file",
        codexHome: join(directory, "codex"),
      },
      { fetchImpl, promptSecret, report, login },
    );

    expect(report).toHaveBeenCalledWith(expect.stringContaining("rejected by https://www.runtraice.com"));
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Opening browser authorization"));
    expect(promptSecret).not.toHaveBeenCalled();
    expect(login).toHaveBeenCalledOnce();
    const config = JSON.parse(readFileSync(configPath, "utf8")) as CollectorConfig;
    expect(config.authorization).toMatchObject({
      type: "oauth",
      workspaceId: "workspace-1",
      workspaceName: "Staging Workspace",
    });
    expect(await readCollectorCredential(config.credential!)).toContain("tr_oauth_at_secret");
  });

  it("authorizes a different server before presenting the saved credential", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-setup-server-change-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      serverUrl: "https://www.runtraice.com",
      apiKey: "production-key",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });
    const login = successfulBrowserLogin();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://staging.runtraice.com/api/v1/collector/me");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tr_oauth_at_secret");
      return Response.json({ usage: [] });
    });

    await setupAgent(
      {
        agent: "codex",
        configPath,
        serverUrl: "https://staging.runtraice.com",
        workspaceHint: "friendly-workspace",
        service: false,
        backfill: false,
        credentialStore: "file",
        codexHome: join(directory, "codex"),
      },
      { fetchImpl, login },
    );

    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://staging.runtraice.com",
        workspaceHint: "friendly-workspace",
      }),
      expect.any(Object),
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const config = JSON.parse(readFileSync(configPath, "utf8")) as CollectorConfig;
    expect(config.serverUrl).toBe("https://staging.runtraice.com");
    expect(config.authorization?.workspaceName).toBe("Staging Workspace");
  });

  it("reports a healthy collector without exposing its credential", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-status-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    await installAgent({
      agent: "codex",
      configPath,
      serverUrl: "https://runtraice.com",
      apiKey: "status-secret-key",
      credentialStore: "file",
      codexHome: join(directory, "codex"),
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:4318")) {
        return Response.json({ ok: true, service: "traice-collector", agents: ["codex"] });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer status-secret-key");
      return Response.json({ usage: [] });
    });

    const result = await getCollectorStatus(
      { configPath, timeoutMs: 500 },
      {
        fetchImpl,
        checkService: () => ({ ok: true, platform: "darwin", state: "running" }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      config: { ok: true, serverUrl: "https://www.runtraice.com", agents: ["codex"] },
      credential: { ok: true, backend: "protected-file" },
      service: { ok: true, state: "running" },
      listener: { ok: true },
      server: { ok: true },
    });
    expect(JSON.stringify(result)).not.toContain("status-secret-key");
    expect(formatCollectorStatus(result)).toContain("trAIce Collector: healthy");
  });

  it("returns actionable status when the config is missing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-status-missing-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "missing.json");

    const result = await getCollectorStatus(
      { configPath },
      { checkService: () => ({ ok: false, platform: "darwin", state: "not-installed" }) },
    );

    expect(result.ok).toBe(false);
    expect(result.config).toMatchObject({ ok: false, path: configPath });
    expect(result.credential.message).toContain("Skipped");
  });

  it("distinguishes an installed but stopped macOS service", () => {
    const directory = mkdtempSync(join(tmpdir(), "traice-collector-status-service-"));
    temporaryDirectories.push(directory);
    const definitionPath = join(directory, "Library/LaunchAgents/com.traice.collector.plist");
    mkdirSync(join(directory, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(definitionPath, "<plist />");

    const result = getCollectorServiceStatus({
      platform: "darwin",
      home: directory,
      uid: 501,
      run: () => ({ status: 113, stdout: "", stderr: "Could not find service" }),
    });

    expect(result).toMatchObject({ ok: false, state: "stopped", definitionPath });
  });
});

function successfulBrowserLogin() {
  return vi.fn(
    async (
      options: Parameters<typeof loginAndStoreCollectorAuthorization>[0],
      dependencies?: Parameters<typeof loginAndStoreCollectorAuthorization>[1],
    ) =>
      loginAndStoreCollectorAuthorization(
        {
          ...options,
          noBrowser: true,
        },
        {
          ...dependencies,
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
              Response.json({
                device_code: "device-secret",
                user_code: "ABCD-EFGH",
                verification_uri: "https://staging.runtraice.com/device",
                expires_in: 600,
                interval: 5,
              }),
            )
            .mockResolvedValueOnce(
              Response.json({
                access_token: "tr_oauth_at_secret",
                refresh_token: "tr_oauth_rt_secret",
                expires_in: 3600,
                scope: "collector:status internal_usage:dedupe internal_usage:write",
                workspace: { id: "workspace-1", name: "Staging Workspace" },
                user: { email: "alex@example.com" },
              }),
            ),
          report: () => {},
          sleep: async () => {},
          now: Date.now,
        },
      ),
  );
}

function collectorConfig(): CollectorConfig {
  return {
    version: 1,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    serverUrl: "https://runtraice.com",
    apiKey: "lm_test",
    listenHost: "127.0.0.1",
    listenPort: 4318,
    includePrompts: false,
    enabledAgents: ["codex"],
    identity,
    sources: { codex: defaultSourceForAgent("codex") },
  };
}

function usageEvent(index: number): InternalUsageEvent {
  return {
    occurredAt: "2026-07-10T00:00:00.000Z",
    sourceKey: "codex-local",
    sourceName: "Codex local collector",
    sourceKind: "codex_otel",
    tool: "codex",
    category: "coding_agent",
    sourceEventId: `event-${index}`,
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    costUsd: 0,
    costBasis: "usage_only",
  };
}

function logPayload(serviceName: string, model: string, inputTokens: number, outputTokens: number) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1783641600000000000",
                severityText: "INFO",
                body: { stringValue: "response.completed" },
                attributes: [
                  { key: "event.name", value: { stringValue: "response.completed" } },
                  { key: "gen_ai.request.model", value: { stringValue: model } },
                  { key: "session.id", value: { stringValue: "session-1" } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: String(inputTokens) } },
                  { key: "gen_ai.usage.output_tokens", value: { intValue: String(outputTokens) } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function metricPayload(metricName: string, value: number) {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: "1783641600000000000",
                      attributes: [{ key: "gen_ai.request.model", value: { stringValue: "claude-3-5-sonnet" } }],
                      asInt: String(value),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function currentCodexLogPayload() {
  const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "0",
                attributes: [
                  attribute("event.name", "codex.sse_event"),
                  attribute("event.kind", "response.completed"),
                  attribute("event.timestamp", "2026-07-18T14:33:35.712Z"),
                  attribute("input_token_count", "16151"),
                  attribute("output_token_count", "23"),
                  attribute("cached_token_count", "2432"),
                  attribute("reasoning_token_count", "14"),
                  attribute("tool_token_count", "16174"),
                  attribute("conversation.id", "conversation-1"),
                  attribute("model", "gpt-5.4"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
