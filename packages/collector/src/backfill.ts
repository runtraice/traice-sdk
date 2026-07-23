import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InternalUsageEvent } from "@traice/protocol";
import { createCollectorAccessTokenProvider } from "./auth";
import { defaultSourceForAgent, loadCollectorConfig, resolveConfigPath } from "./config";
import { resolveHome } from "./fs";
import { forwardEvents } from "./run";

interface TokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

interface CodexSessionRow {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    id?: unknown;
    session_id?: unknown;
    model?: unknown;
    info?: { last_token_usage?: TokenUsage; total_token_usage?: TokenUsage };
  };
}

interface HistoricalUsageEvent {
  sourceEventId: string;
  occurredAt: string;
  runId: string;
  model?: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexBackfillDryRunOptions {
  codexHome?: string;
  since: string;
  until?: string;
  now?: Date;
}

export interface CodexBackfillOptions extends CodexBackfillDryRunOptions {
  configPath?: string;
  onProgress?: (progress: { processed: number; total: number; accepted: number }) => void;
}

interface CodexBackfillScanSummary {
  since: string;
  until: string;
  filesDiscovered: number;
  filesWithUsage: number;
  sessionsWithUsage: number;
  usageEvents: number;
  invalidLines: number;
  duplicateEventIds: number;
  repeatedSnapshotsSkipped: number;
  earliestEventAt?: string;
  latestEventAt?: string;
  tokens: { input: number; cachedInput: number; output: number; reasoningOutput: number; total: number };
}

export interface CodexBackfillDryRunSummary extends CodexBackfillScanSummary {
  dryRun: true;
  sendsData: false;
}

export interface CodexBackfillSummary extends CodexBackfillScanSummary {
  dryRun: false;
  sendsData: true;
  liveEventsInspected: number;
  crossModeDuplicatesSkipped: number;
  uploadCandidates: number;
  accepted: number;
  dropped: number;
}

export function dryRunCodexBackfill(options: CodexBackfillDryRunOptions): CodexBackfillDryRunSummary {
  const result = scanCodexHistory(options);
  return { dryRun: true, sendsData: false, ...result.summary };
}

export async function backfillCodex(options: CodexBackfillOptions): Promise<CodexBackfillSummary> {
  const result = scanCodexHistory(options);
  const configPath = resolveConfigPath(options.configPath);
  const config = loadCollectorConfig(configPath);
  const getAccessToken = createCollectorAccessTokenProvider(configPath);
  await getAccessToken();

  const source = config.sources.codex ?? defaultSourceForAgent("codex");
  const liveEvents = await fetchLiveEvents({
    serverUrl: config.serverUrl,
    getAccessToken,
    since: result.summary.since,
    until: result.summary.until,
    sourceKey: source.sourceKey,
  });
  const liveKeys = countedSemanticKeys(liveEvents);
  let crossModeDuplicatesSkipped = 0;
  const events: InternalUsageEvent[] = [];

  for (const event of result.events) {
    const key = semanticUsageKey(event);
    const remaining = liveKeys.get(key) ?? 0;
    if (remaining > 0) {
      liveKeys.set(key, remaining - 1);
      crossModeDuplicatesSkipped += 1;
      continue;
    }
    events.push({
      ...source,
      ...config.identity,
      sourceEventId: event.sourceEventId,
      occurredAt: event.occurredAt,
      runId: event.runId,
      ...(event.model ? { model: event.model } : {}),
      inputTokens: event.inputTokens,
      cacheReadTokens: event.cacheReadTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.totalTokens,
      costBasis: "usage_only",
      status: "unknown",
      metadata: { historySource: "codex-session-jsonl", reasoningOutputTokens: event.reasoningOutputTokens },
    });
  }

  const accepted = await forwardEvents(config, events, {
    batchSize: 50,
    onBatch: options.onProgress,
    getAccessToken,
  });
  return {
    dryRun: false,
    sendsData: true,
    ...result.summary,
    liveEventsInspected: liveEvents.length,
    crossModeDuplicatesSkipped,
    uploadCandidates: events.length,
    accepted,
    dropped: events.length - accepted,
  };
}

function scanCodexHistory(options: CodexBackfillDryRunOptions): {
  summary: CodexBackfillScanSummary;
  events: HistoricalUsageEvent[];
} {
  const now = options.now ?? new Date();
  const since = parseBoundary(options.since, now, "since");
  const until = options.until ? parseBoundary(options.until, now, "until") : now;
  if (since >= until)
    throw new Error(`Backfill --since must be before --until (${since.toISOString()} >= ${until.toISOString()}).`);

  const sessionsRoot = resolve(resolveHome(options.codexHome ?? "~/.codex"), "sessions");
  const files = sessionFiles(sessionsRoot);
  const eventIds = new Set<string>();
  const sessions = new Set<string>();
  const events: HistoricalUsageEvent[] = [];
  let filesWithUsage = 0;
  let invalidLines = 0;
  let duplicateEventIds = 0;
  let repeatedSnapshotsSkipped = 0;
  let earliestEventAt: string | undefined;
  let latestEventAt: string | undefined;
  const tokens = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 };

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let sessionId: string | undefined;
    let model: string | undefined;
    let previousTotalUsageKey: string | undefined;
    let previousTotalTokens: number | undefined;
    let resetEpoch = 0;
    let fileHasUsage = false;

    for (const line of lines) {
      if (!line.trim()) continue;
      let row: CodexSessionRow;
      try {
        row = JSON.parse(line) as CodexSessionRow;
      } catch {
        invalidLines += 1;
        continue;
      }

      if (row.type === "session_meta") {
        sessionId = stringValue(row.payload?.id) ?? stringValue(row.payload?.session_id) ?? sessionId;
        continue;
      }
      if (row.type === "turn_context") {
        model = stringValue(row.payload?.model) ?? model;
        continue;
      }
      if (row.type !== "event_msg" || row.payload?.type !== "token_count") continue;

      const occurredAt = dateValue(row.timestamp);
      const usage = row.payload.info?.last_token_usage;
      const cumulativeUsage = row.payload.info?.total_token_usage;
      if (!occurredAt || !usage || !cumulativeUsage) continue;

      const cumulative = normalizedUsage(cumulativeUsage);
      const cumulativeKey = JSON.stringify(cumulative);
      if (cumulativeKey === previousTotalUsageKey) {
        if (occurredAt >= since && occurredAt < until) repeatedSnapshotsSkipped += 1;
        continue;
      }
      if (previousTotalTokens !== undefined && cumulative.total < previousTotalTokens) resetEpoch += 1;
      previousTotalUsageKey = cumulativeKey;
      previousTotalTokens = cumulative.total;
      if (occurredAt < since || occurredAt >= until) continue;

      const normalized = normalizedUsage(usage);
      const resolvedSessionId = sessionId ?? relativeSessionId(sessionsRoot, file);
      const sourceEventId = stableEventId(resolvedSessionId, resetEpoch, cumulative);
      if (eventIds.has(sourceEventId)) {
        duplicateEventIds += 1;
        continue;
      }

      eventIds.add(sourceEventId);
      sessions.add(resolvedSessionId);
      events.push({
        sourceEventId,
        occurredAt: occurredAt.toISOString(),
        runId: resolvedSessionId,
        ...(model ? { model } : {}),
        inputTokens: normalized.input,
        cacheReadTokens: normalized.cachedInput,
        outputTokens: normalized.output,
        totalTokens: normalized.total,
        reasoningOutputTokens: normalized.reasoningOutput,
      });
      fileHasUsage = true;
      tokens.input += normalized.input;
      tokens.cachedInput += normalized.cachedInput;
      tokens.output += normalized.output;
      tokens.reasoningOutput += normalized.reasoningOutput;
      tokens.total += normalized.total;
      const timestamp = occurredAt.toISOString();
      if (!earliestEventAt || timestamp < earliestEventAt) earliestEventAt = timestamp;
      if (!latestEventAt || timestamp > latestEventAt) latestEventAt = timestamp;
    }
    if (fileHasUsage) filesWithUsage += 1;
  }

  return {
    summary: {
      since: since.toISOString(),
      until: until.toISOString(),
      filesDiscovered: files.length,
      filesWithUsage,
      sessionsWithUsage: sessions.size,
      usageEvents: events.length,
      invalidLines,
      duplicateEventIds,
      repeatedSnapshotsSkipped,
      ...(earliestEventAt ? { earliestEventAt } : {}),
      ...(latestEventAt ? { latestEventAt } : {}),
      tokens,
    },
    events,
  };
}

async function fetchLiveEvents(options: {
  serverUrl: string;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
  since: string;
  until: string;
  sourceKey: string;
}): Promise<HistoricalUsageEvent[]> {
  const url = new URL("/api/v1/collector/usage", options.serverUrl);
  url.searchParams.set("limit", "500");
  url.searchParams.set("since", options.since);
  url.searchParams.set("sourceKey", options.sourceKey);
  url.searchParams.set("until", options.until);
  let response = await fetch(url, {
    headers: { authorization: `Bearer ${await options.getAccessToken(false)}` },
  });
  if (response.status === 401) {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${await options.getAccessToken(true)}` },
    });
  }
  if (!response.ok) throw new Error(`GET /api/v1/collector/usage returned ${response.status}`);
  const body = (await response.json()) as { usage?: Array<Record<string, unknown>> };
  const rows = Array.isArray(body.usage) ? body.usage : [];
  const until = new Date(options.until);
  const liveRows = rows.filter((row) => {
    const occurredAt = dateValue(row.occurredAt);
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    return occurredAt && occurredAt < until && metadata.historySource !== "codex-session-jsonl";
  });
  if (rows.length === 500 && liveRows.length > 0) {
    throw new Error(
      "Cross-mode deduplication found 500 server rows and cannot prove the overlap is complete. Choose an earlier --until boundary before live collection began.",
    );
  }
  return liveRows.flatMap((row) => {
    const occurredAt = dateValue(row.occurredAt);
    const runId = stringValue(row.runId);
    if (!occurredAt || !runId) return [];
    return [
      {
        sourceEventId: "server-live-event",
        occurredAt: occurredAt.toISOString(),
        runId,
        ...(stringValue(row.model) ? { model: stringValue(row.model) } : {}),
        inputTokens: numberValue(row.inputTokens),
        cacheReadTokens: numberValue(row.cacheReadTokens),
        outputTokens: numberValue(row.outputTokens),
        totalTokens: numberValue(row.totalTokens),
        reasoningOutputTokens: 0,
      },
    ];
  });
}

function countedSemanticKeys(events: HistoricalUsageEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    const key = semanticUsageKey(event);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function semanticUsageKey(event: HistoricalUsageEvent): string {
  return JSON.stringify({
    runId: event.runId,
    inputTokens: event.inputTokens,
    cacheReadTokens: event.cacheReadTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
  });
}

function sessionFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function parseBoundary(value: string, now: Date, option: "since" | "until"): Date {
  const duration = /^(\d+)([mhdw])$/.exec(value.trim());
  if (duration) {
    const amount = Number(duration[1]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[duration[2] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - amount * unitMs);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --${option} value "${value}". Use an ISO date/time or a duration such as 14d.`);
  }
  return parsed;
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativeSessionId(root: string, file: string): string {
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

function normalizedUsage(
  usage: TokenUsage,
): Record<"input" | "cachedInput" | "output" | "reasoningOutput" | "total", number> {
  return {
    input: numberValue(usage.input_tokens),
    cachedInput: numberValue(usage.cached_input_tokens),
    output: numberValue(usage.output_tokens),
    reasoningOutput: numberValue(usage.reasoning_output_tokens),
    total: numberValue(usage.total_tokens),
  };
}

function stableEventId(sessionId: string, resetEpoch: number, cumulativeUsage: Record<string, number>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ sessionId, resetEpoch, cumulativeUsage }))
    .digest("hex")
    .slice(0, 32);
  return `codex-jsonl-${digest}`;
}
