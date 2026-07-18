import { createServer, type IncomingMessage } from "node:http";
import type { InternalUsageEvent } from "@traice/protocol";
import { defaultSourceForAgent, loadCollectorConfig, resolveConfigPath, writeCollectorConfig } from "./config";
import { readCollectorCredential, storeCollectorCredential } from "./credentials";
import { normalizeClaudeCodeOtlpLogs, normalizeClaudeCodeOtlpMetrics } from "./adapters/claude-code";
import { normalizeCodexOtlpLogs } from "./adapters/codex";
import type { AgentName, CollectorConfig, CollectorRunOptions, OtlpNormalizeOptions } from "./types";

const MAX_BATCH_SIZE = 10;
const MAX_FORWARD_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 250;

export type ForwardDependencies = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  batchSize?: number;
  maxAttempts?: number;
};

const enqueueForward = createSerializedEventForwarder();

export async function runCollector(options: CollectorRunOptions = {}): Promise<void> {
  const configPath = resolveConfigPath(options.configPath);
  const config = loadCollectorConfig(configPath);
  const listenHost = options.listenHost ?? config.listenHost;
  const listenPort = options.listenPort ?? config.listenPort;
  const apiKey = await resolveApiKey(config, configPath);

  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "traice-collector", agents: config.enabledAgents }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    const receivedAt = new Date().toISOString();
    let payload: unknown;

    try {
      payload = await readJsonBody(req);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request body" }));
      return;
    }

    try {
      const events = normalizePayloadForRequest(req.url ?? "", payload, config, options.agent, receivedAt);
      const sent = await enqueueForward({ ...config, apiKey }, events);
      if (events.length > 0 || sent > 0) {
        console.log(JSON.stringify({ receivedAt, path: req.url, candidates: events.length, sent }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: sent, candidates: events.length }));
    } catch (error) {
      console.error(`[traice-collector] ingest failed: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "traice_collector_ingest_failed" }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(listenPort, listenHost, () => resolve());
  });

  console.log(`trAIce collector listening on http://${listenHost}:${listenPort}`);
  console.log(`Forwarding internal usage to ${config.serverUrl}/api/v1/internal-usage`);
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
    const options: OtlpNormalizeOptions = { source, identity: config.identity, receivedAt };

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

export function createSerializedEventForwarder(dependencies: ForwardDependencies = {}) {
  let tail: Promise<void> = Promise.resolve();

  return (config: CollectorConfig, events: InternalUsageEvent[]): Promise<number> => {
    const operation = tail.then(() => forwardEvents(config, events, dependencies));
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

export async function forwardEvents(
  config: CollectorConfig,
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
  }

  return sent;
}

async function postBatch(
  config: CollectorConfig,
  batch: Record<string, unknown>[],
  dependencies: ForwardDependencies,
): Promise<{ accepted?: number }> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxAttempts = Math.max(1, dependencies.maxAttempts ?? MAX_FORWARD_ATTEMPTS);
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${config.serverUrl}/api/v1/internal-usage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
      }
      continue;
    }

    if (response.ok) {
      return (await response.json().catch(() => ({}))) as { accepted?: number };
    }

    const text = await response.text().catch(() => "");
    lastError = new Error(`POST /api/v1/internal-usage returned ${response.status}: ${text.slice(0, 500)}`);
    if (!isRetryableStatus(response.status)) throw lastError;

    if (attempt + 1 < maxAttempts) {
      await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Internal usage forwarding failed");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function resolveApiKey(config: CollectorConfig, configPath: string): Promise<string> {
  if (process.env.TRAICE_API_KEY) return process.env.TRAICE_API_KEY;
  if (config.credential) return readCollectorCredential(config.credential);
  if (config.apiKey) {
    const stored = await storeCollectorCredential(configPath, config.apiKey);
    config.credential = stored.credential;
    delete config.apiKey;
    writeCollectorConfig(config, configPath);
    if (stored.warning) console.warn(`[traice-collector] ${stored.warning}`);
    return readCollectorCredential(stored.credential);
  }
  throw new Error("Missing collector API key. Re-run install with TRAICE_API_KEY or --api-key-stdin.");
}

function toIngestEvent(event: InternalUsageEvent): Record<string, unknown> {
  return {
    ...event,
    timestamp: event.occurredAt,
  };
}

function inferAgents(payload: unknown, enabledAgents: AgentName[]): AgentName[] {
  if (enabledAgents.length <= 1) return enabledAgents;

  const text = JSON.stringify(payload).toLowerCase();
  if (text.includes("claude")) return enabledAgents.includes("claude-code") ? ["claude-code"] : [];
  if (text.includes("codex")) return enabledAgents.includes("codex") ? ["codex"] : [];

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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}
