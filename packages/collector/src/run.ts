import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  assertValidInternalUsageEvent,
  normalizeInternalUsageEvent,
  redactMetadata,
  type InternalUsageEvent,
  type JsonRecord,
} from "@traice/protocol";
import packageMetadata from "../package.json";
import { createCollectorAccessTokenProvider } from "./auth";
import { configDir, defaultSourceForAgent, loadCollectorConfig, resolveConfigPath } from "./config";
import {
  allRoutedDestinationNames,
  configForDestination,
  routedDestinationNames,
  type ResolvedCollectorConfig,
} from "./destinations";
import { normalizeClaudeCodeOtlpLogs, normalizeClaudeCodeOtlpMetrics } from "./adapters/claude-code";
import { normalizeCodexOtlpLogs } from "./adapters/codex";
import { extractLogRecords, extractMetricPoints, pickString } from "./otel";
import { CollectorOutbox } from "./outbox";
import type { AgentName, CollectorConfig, CollectorRunOptions, OtlpNormalizeOptions } from "./types";
import { checkCollectorUpdate } from "./updates";
import { eventForCollectorDestination } from "./context";

const MAX_BATCH_SIZE = 10;
const MAX_FORWARD_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_LOCAL_BODY_BYTES = 1024 * 1024;
const MAX_LOCAL_DIRECT_EVENTS = 100;
const OUTBOX_MAX_EVENTS = 10_000;
const OUTBOX_RETRY_INTERVAL_MS = 5_000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type ForwardDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  maxRetryDelayMs?: number;
  random?: () => number;
  onRetry?: (delayMs: number) => void;
  onBatch?: (progress: { processed: number; total: number; accepted: number }) => void;
  getAccessToken?: (forceRefresh?: boolean) => Promise<string>;
};

export type CollectorDestinationForwarder = {
  name: string;
  config: ResolvedCollectorConfig;
  forward: (config: ResolvedCollectorConfig, events: InternalUsageEvent[]) => Promise<number>;
};

export type DestinationDelivery = {
  name: string;
  primary: boolean;
  accepted: number;
  error?: string;
};

type CollectorDestinationRuntime = {
  name: string;
  outbox: CollectorOutbox;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  drainPromise: Promise<void> | null;
};

export async function runCollector(options: CollectorRunOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  const config = loadCollectorConfig(configPath);
  const listenHost = options.listenHost ?? config.listenHost;
  const listenPort = options.listenPort ?? config.listenPort;
  let stopped = false;
  const runtimes = new Map<string, CollectorDestinationRuntime>();
  const runtimePromises = new Map<string, Promise<CollectorDestinationRuntime>>();

  const destinationRuntime = async (name: string): Promise<CollectorDestinationRuntime> => {
    const existing = runtimes.get(name);
    if (existing) return existing;
    const pending = runtimePromises.get(name);
    if (pending) return pending;
    const creation = (async () => {
      const outboxName = `outbox-${name}.ndjson`;
      const runtime: CollectorDestinationRuntime = {
        name,
        outbox: new CollectorOutbox(join(configDir(configPath), "state", outboxName), OUTBOX_MAX_EVENTS),
        getAccessToken: createCollectorAccessTokenProvider(configPath, {}, name),
        drainPromise: null,
      };
      await runtime.outbox.initialize();
      runtimes.set(name, runtime);
      return runtime;
    })();
    runtimePromises.set(name, creation);
    try {
      return await creation;
    } finally {
      runtimePromises.delete(name);
    }
  };

  const resolveDestinations = async (current: CollectorConfig, names?: string[]) => {
    const selectedNames = names ?? allRoutedDestinationNames(current, options.destinations);
    return Promise.all(
      selectedNames.map(async (name) => ({
        name,
        config: configForDestination(current, name),
        runtime: await destinationRuntime(name),
      })),
    );
  };

  const drainDestination = (runtime: CollectorDestinationRuntime): Promise<void> => {
    if (runtime.drainPromise) return runtime.drainPromise;
    runtime.drainPromise = (async () => {
      while (!stopped) {
        const events = await runtime.outbox.peek(MAX_BATCH_SIZE);
        if (events.length === 0) return;
        let retries = 0;
        try {
          const current = loadCollectorConfig(configPath);
          const destinationConfig = configForDestination(current, runtime.name);
          await forwardEvents(destinationConfig, events, {
            getAccessToken: runtime.getAccessToken,
            onRetry: () => {
              retries++;
            },
          });
          await runtime.outbox.acknowledge(events.map((event) => event.sourceEventId));
        } catch (error) {
          runtime.outbox.recordFailure(retries);
          console.error(
            `[traice-collector] delivery to "${runtime.name}" delayed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
      }
    })().finally(() => {
      runtime.drainPromise = null;
    });
    return runtime.drainPromise;
  };

  const initialDestinations = await resolveDestinations(config);
  warmDestinationAuthorizations(
    initialDestinations.map((destination) => ({
      name: destination.name,
      getAccessToken: destination.runtime.getAccessToken,
    })),
  );
  const retryTimer = setInterval(() => {
    for (const runtime of runtimes.values()) drainDestination(runtime).catch(() => {});
  }, OUTBOX_RETRY_INTERVAL_MS);
  if (retryTimer.unref) retryTimer.unref();

  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const current = loadCollectorConfig(configPath);
      const destinationNames = allRoutedDestinationNames(current, options.destinations);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          service: "traice-collector",
          agents: current.enabledAgents,
          destinations: destinationNames,
          delivery: Object.fromEntries(
            destinationNames.map((name) => [name, runtimes.get(name)?.outbox.stats() ?? null]),
          ),
        }),
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    const receivedAt = new Date().toISOString();
    let payload: unknown;

    try {
      payload = await readJsonBody(req, MAX_LOCAL_BODY_BYTES);
    } catch (error) {
      res.writeHead(error instanceof LocalPayloadTooLargeError ? 413 : 400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request body" }));
      return;
    }

    const current = loadCollectorConfig(configPath);
    let events: InternalUsageEvent[];
    try {
      events =
        requestPath(req) === "/v1/internal-usage"
          ? normalizeDirectInternalUsagePayload(payload, current)
          : normalizePayloadForRequest(req.url ?? "", payload, current, options.agent, receivedAt);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid internal usage payload" }));
      return;
    }

    try {
      const routedEvents = routeEvents(current, events, options.destinations);
      const destinationNames =
        routedEvents.size > 0 ? [...routedEvents.keys()] : allRoutedDestinationNames(current, options.destinations);
      const destinations = await resolveDestinations(current, destinationNames);
      const settled = await Promise.allSettled(
        destinations.map((destination) => destination.runtime.outbox.enqueue(routedEvents.get(destination.name) ?? [])),
      );
      const deliveries = settled.map((result, index) => ({
        name: destinations[index]!.name,
        primary: index === 0,
        ...(result.status === "fulfilled"
          ? result.value
          : { queued: 0, deduplicated: 0, dropped: 0, error: errorMessage(result.reason) }),
      }));
      const primary = deliveries[0]!;
      if ("error" in primary) throw new Error(`Destination "${primary.name}" failed: ${primary.error}`);
      for (const delivery of deliveries.slice(1)) {
        if ("error" in delivery) {
          console.error(`[traice-collector] destination "${delivery.name}" queue failed: ${delivery.error}`);
        }
      }
      if (events.length > 0) {
        console.log(JSON.stringify({ receivedAt, path: req.url, candidates: events.length, destinations: deliveries }));
      }
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: primary.queued, candidates: events.length, destinations: deliveries }));
      for (const [index, destination] of destinations.entries()) {
        if (settled[index]?.status === "fulfilled") drainDestination(destination.runtime).catch(() => {});
      }
    } catch (error) {
      console.error(`[traice-collector] ingest failed: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "traice_collector_ingest_failed" }));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  await new Promise<void>((resolve) => {
    server.listen(listenPort, listenHost, () => resolve());
  });

  console.log(`trAIce collector listening on http://${listenHost}:${listenPort}`);
  console.log(
    `Forwarding internal usage to ${initialDestinations
      .map((destination) => `${destination.name} (${destination.config.serverUrl})`)
      .join(", ")}`,
  );
  const reportUpdate = () =>
    checkCollectorUpdate()
      .then((update) => {
        if (update.updateAvailable) {
          console.error(
            `[traice-collector] update available: ${update.currentVersion} -> ${update.latestVersion}. Run "npx @traice/collector@latest update".`,
          );
        }
      })
      .catch(() => {});
  reportUpdate();
  const updateTimer = setInterval(reportUpdate, UPDATE_CHECK_INTERVAL_MS);
  if (updateTimer.unref) updateTimer.unref();
  for (const destination of initialDestinations) drainDestination(destination.runtime).catch(() => {});

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(retryTimer);
    clearInterval(updateTimer);
    server.close();
    for (const runtime of runtimes.values()) runtime.drainPromise?.catch(() => {});
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function warmDestinationAuthorizations(
  destinations: Array<{ name: string; getAccessToken: (forceRefresh?: boolean) => Promise<string> }>,
  report: (message: string) => void = console.error,
): void {
  for (const destination of destinations) {
    void destination.getAccessToken().catch((error) => {
      report(
        `[traice-collector] destination "${destination.name}" authorization delayed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
}

function routeEvents(
  config: CollectorConfig,
  events: InternalUsageEvent[],
  destinationsOverride?: string[],
): Map<string, InternalUsageEvent[]> {
  const routed = new Map<string, InternalUsageEvent[]>();
  for (const event of events) {
    const agent: AgentName | undefined =
      event.tool === "codex" ? "codex" : event.tool === "claude-code" ? "claude-code" : undefined;
    const destinations = agent
      ? routedDestinationNames(config, agent, destinationsOverride)
      : allRoutedDestinationNames(config, destinationsOverride);
    for (const destination of destinations) {
      routed.set(destination, [
        ...(routed.get(destination) ?? []),
        eventForCollectorDestination(config, destination, event),
      ]);
    }
  }
  return routed;
}

export async function forwardEventsToDestinations(
  events: InternalUsageEvent[],
  destinations: CollectorDestinationForwarder[],
): Promise<DestinationDelivery[]> {
  if (destinations.length === 0) throw new Error("No collector destinations are configured.");
  const settled = await Promise.allSettled(
    destinations.map((destination) => destination.forward(destination.config, events)),
  );
  return settled.map((result, index) => ({
    name: destinations[index]!.name,
    primary: index === 0,
    accepted: result.status === "fulfilled" ? result.value : 0,
    ...(result.status === "rejected"
      ? { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }
      : {}),
  }));
}

export function normalizePayloadForRequest(
  path: string,
  payload: unknown,
  config: CollectorConfig,
  selectedAgent: AgentName | undefined,
  receivedAt: string,
): InternalUsageEvent[] {
  const agents = selectedAgent ? [selectedAgent] : inferAgents(payload, config.enabledAgents);
  const events: InternalUsageEvent[] = [];

  for (const agent of agents) {
    const source = config.sources[agent] ?? defaultSourceForAgent(agent);
    const options: OtlpNormalizeOptions = {
      source,
      identity: config.identity,
      receivedAt,
      includePrompts: config.includePrompts,
    };

    if (agent === "claude-code") {
      if (path.includes("metrics")) {
        events.push(...normalizeClaudeCodeOtlpMetrics(payload, options));
      } else {
        events.push(...normalizeClaudeCodeOtlpLogs(payload, options));
      }
    } else if (agent === "codex") {
      events.push(...normalizeCodexOtlpLogs(payload, options));
    }
  }

  return dedupeEvents(events);
}

export function normalizeDirectInternalUsagePayload(payload: unknown, config: CollectorConfig): InternalUsageEvent[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Direct internal usage payload must be a JSON object.");
  }
  const rawEvents = (payload as { events?: unknown }).events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new Error("Direct internal usage payload must contain a non-empty events array.");
  }
  if (rawEvents.length > MAX_LOCAL_DIRECT_EVENTS) {
    throw new Error(`Direct internal usage payload may contain at most ${MAX_LOCAL_DIRECT_EVENTS} events.`);
  }

  return dedupeEvents(
    rawEvents.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Each direct internal usage event must be a JSON object.");
      }
      const candidate = raw as InternalUsageEvent;
      const event = normalizeInternalUsageEvent({
        ...candidate,
        ...config.identity,
        ...(candidate.metadata ? { metadata: redactMetadata(candidate.metadata) as JsonRecord } : {}),
      });
      assertValidInternalUsageEvent(event);
      return event;
    }),
  );
}

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
}

export function createSerializedEventForwarder(dependencies: ForwardDependencies = {}) {
  let tail: Promise<void> = Promise.resolve();

  return (config: ResolvedCollectorConfig, events: InternalUsageEvent[]): Promise<number> => {
    const operation = tail.then(() => forwardEvents(config, events, dependencies));
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

export async function forwardEvents(
  config: ResolvedCollectorConfig,
  events: InternalUsageEvent[],
  dependencies: ForwardDependencies = {},
): Promise<number> {
  if (events.length === 0) return 0;
  const batchSize = Math.max(1, dependencies.batchSize ?? MAX_BATCH_SIZE);
  let sent = 0;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize).map(toIngestEvent);
    const body = await postBatch(config, batch, dependencies);
    sent += Number(body.accepted ?? batch.length);
    dependencies.onBatch?.({
      processed: Math.min(i + batch.length, events.length),
      total: events.length,
      accepted: sent,
    });
  }

  return sent;
}

async function postBatch(
  config: ResolvedCollectorConfig,
  batch: Record<string, unknown>[],
  dependencies: ForwardDependencies,
): Promise<{ accepted?: number }> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxAttempts = Math.max(1, dependencies.maxAttempts ?? MAX_FORWARD_ATTEMPTS);
  const requestTimeoutMs = Math.max(100, dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  const maxRetryDelayMs = Math.max(0, dependencies.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS);
  const random = dependencies.random ?? Math.random;
  let lastError: unknown;
  let refreshedAfterUnauthorized = false;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const accessToken = dependencies.getAccessToken ? await dependencies.getAccessToken(false) : config.apiKey;
      if (!accessToken) throw new Error("No collector credential is available.");
      response = await fetchImpl(`${config.serverUrl}/api/v1/internal-usage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "x-traice-collector-version": packageMetadata.version,
        },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        const delayMs = jitteredBackoffMs(attempt, maxRetryDelayMs, random);
        dependencies.onRetry?.(delayMs);
        await sleep(delayMs);
      }
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      return (await response.json().catch(() => ({}))) as { accepted?: number };
    }

    const text = await response.text().catch(() => "");
    lastError = new Error(`POST /api/v1/internal-usage returned ${response.status}: ${text.slice(0, 500)}`);
    if (response.status === 401 && dependencies.getAccessToken && !refreshedAfterUnauthorized) {
      await dependencies.getAccessToken(true);
      refreshedAfterUnauthorized = true;
      continue;
    }
    if (!isRetryableStatus(response.status)) throw lastError;

    if (attempt + 1 < maxAttempts) {
      const delayMs = retryDelayMs(response, attempt, maxRetryDelayMs, random);
      dependencies.onRetry?.(delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Internal usage forwarding failed");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryDelayMs(response: Response, attempt: number, capMs: number, random: () => number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(capMs, Math.max(0, seconds * 1000));
    const dateMs = new Date(retryAfter).getTime();
    if (Number.isFinite(dateMs)) return Math.min(capMs, Math.max(0, dateMs - Date.now()));
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetSeconds = resetHeader == null ? Number.NaN : Number(resetHeader);
  if (Number.isFinite(resetSeconds) && resetSeconds >= 0) return Math.min(capMs, resetSeconds * 1000);
  return jitteredBackoffMs(attempt, capMs, random);
}

function jitteredBackoffMs(attempt: number, capMs: number, random: () => number): number {
  const base = Math.min(capMs, BASE_RETRY_DELAY_MS * 2 ** attempt);
  return Math.min(capMs, Math.max(0, Math.round(base * (0.5 + random()))));
}

function toIngestEvent(event: InternalUsageEvent): Record<string, unknown> {
  return {
    ...event,
    timestamp: event.occurredAt,
  };
}

export function inferAgents(payload: unknown, enabledAgents: AgentName[]): AgentName[] {
  if (enabledAgents.length <= 1) return enabledAgents;

  const signals = [...extractLogRecords(payload), ...extractMetricPoints(payload)].flatMap((record) => {
    const attributes = { ...record.resourceAttributes, ...record.attributes };
    const recordName = "metricName" in record ? record.metricName : record.name;
    return [
      pickString(attributes, ["service.name", "telemetry.sdk.name", "instrumentation.scope.name"]),
      recordName,
      pickString(attributes, ["agent.name", "tool.name", "event.name"]),
      pickString(attributes, ["model", "gen_ai.request.model", "gen_ai.response.model", "ai.model"]),
    ].filter((value): value is string => Boolean(value));
  });
  const normalized = signals.map((value) => value.toLowerCase());
  const codex = normalized.some(
    (value) => value.includes("codex") || /^gpt(?:-|$)/.test(value) || /^o\d(?:-|$)/.test(value),
  );
  const claude = normalized.some((value) => value.includes("claude"));

  if (codex !== claude) {
    const agent = codex ? "codex" : "claude-code";
    return enabledAgents.includes(agent) ? [agent] : [];
  }

  return [];
}

function dedupeEvents(events: InternalUsageEvent[]): InternalUsageEvent[] {
  const seen = new Set<string>();
  const output: InternalUsageEvent[] = [];
  for (const event of events) {
    if (seen.has(event.sourceEventId)) continue;
    seen.add(event.sourceEventId);
    output.push(event);
  }
  return output;
}

class LocalPayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new LocalPayloadTooLargeError(`request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
