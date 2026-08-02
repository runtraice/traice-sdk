import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import packageMetadata from "../package.json";
import { resolveCollectorAccessToken } from "./auth";
import { loadCollectorConfig } from "./config";
import { collectorDestination, defaultDestinationName, normalizeDestinationName } from "./destinations";

export const DEFAULT_BENCHMARK_PATH = ".traice/benchmark.json";
export const BENCHMARK_STAGE_KINDS = ["setup", "refresh", "execute", "verify"] as const;
export const BENCHMARK_VARIANTS = ["baseline", "candidate"] as const;

export type BenchmarkStageKind = (typeof BENCHMARK_STAGE_KINDS)[number];
export type BenchmarkVariantKey = (typeof BENCHMARK_VARIANTS)[number];

export type BenchmarkStage = {
  kind: BenchmarkStageKind;
  label: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  status: "completed" | "failed" | "skipped";
  command?: string | null;
  sourceRevision?: string | null;
};

export type BenchmarkTaskResult = {
  id: string;
  title: string;
  status: "completed" | "failed" | "error";
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  billableTokens: number;
  costUsdMicros: number;
  durationMs: number;
  retries: number;
  qualityScore: number | null;
};

export type BenchmarkVariantResult = {
  key: string;
  label: string;
  tool: string;
  toolVersion: string | null;
  configuration: string;
  stages: BenchmarkStage[];
  tasks: BenchmarkTaskResult[];
};

export type BenchmarkManifest = {
  schemaVersion: 1;
  title: string;
  summary: string;
  repository: { url: string; revision: string };
  methodologyVersion: string;
  amortizationTaskCount: number | null;
  prompts: string[];
  disclosures: string[];
  baseline: BenchmarkVariantResult;
  candidate: BenchmarkVariantResult;
  createdAt: string;
  updatedAt: string;
};

export type BenchmarkReportSnapshot = Omit<BenchmarkManifest, "createdAt" | "updatedAt"> & {
  measuredAt: string;
  baseline: BenchmarkVariantResult & { metrics: BenchmarkMetrics };
  candidate: BenchmarkVariantResult & { metrics: BenchmarkMetrics };
};

export type BenchmarkMetrics = {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  billableTokens: number;
  costUsdMicros: number;
  taskDurationMs: number;
  setupDurationMs: number;
  refreshDurationMs: number;
  verifyDurationMs: number;
  attemptedTasks: number;
  completedTasks: number;
  errors: number;
  retries: number;
  qualityScore: number | null;
};

export function initializeBenchmark(
  options: {
    path?: string;
    cwd?: string;
    force?: boolean;
    title: string;
    summary: string;
    repositoryUrl?: string;
    repositoryRevision?: string;
    methodologyVersion?: string;
    amortizationTaskCount?: number;
    prompts: string[];
    baselineLabel?: string;
    baselineTool?: string;
    baselineConfiguration?: string;
    candidateLabel?: string;
    candidateTool?: string;
    candidateConfiguration?: string;
    disclosures?: string[];
  },
  now = new Date(),
): { path: string; manifest: BenchmarkManifest } {
  const cwd = resolve(options.cwd ?? process.cwd());
  const path = resolve(cwd, options.path ?? DEFAULT_BENCHMARK_PATH);
  if (existsSync(path) && !options.force) {
    throw new Error(`Benchmark manifest already exists at ${path}. Pass --force to replace it.`);
  }
  const repositoryUrl = normalizeRepositoryUrl(options.repositoryUrl ?? git(cwd, ["remote", "get-url", "origin"]));
  const revision = bounded(options.repositoryRevision ?? git(cwd, ["rev-parse", "HEAD"]), "repository revision", 128);
  const prompts = options.prompts.map((prompt) => bounded(prompt, "prompt", 2_000));
  if (prompts.length < 1 || prompts.length > 100) throw new Error("Provide between 1 and 100 benchmark prompts.");
  const timestamp = now.toISOString();
  const manifest: BenchmarkManifest = {
    schemaVersion: 1,
    title: bounded(options.title, "title", 160),
    summary: bounded(options.summary, "summary", 1_000),
    repository: { url: repositoryUrl, revision },
    methodologyVersion: bounded(options.methodologyVersion ?? "repo-context-v1", "methodology version", 64),
    amortizationTaskCount: positiveIntegerOrNull(options.amortizationTaskCount),
    prompts,
    disclosures: (options.disclosures ?? []).map((value) => bounded(value, "disclosure", 1_000)),
    baseline: emptyVariant({
      key: "baseline",
      label: options.baselineLabel ?? "Baseline",
      tool: options.baselineTool ?? "Coding agent",
      configuration: options.baselineConfiguration ?? "No candidate tool enabled.",
    }),
    candidate: emptyVariant({
      key: "candidate",
      label: options.candidateLabel ?? "Candidate",
      tool: options.candidateTool ?? "Coding agent with candidate tool",
      configuration: options.candidateConfiguration ?? "Candidate tool enabled.",
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeBenchmarkManifest(path, manifest);
  return { path, manifest };
}

export function recordBenchmarkStage(
  options: {
    path?: string;
    cwd?: string;
    variant: BenchmarkVariantKey;
    kind: BenchmarkStageKind;
    label: string;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsdMicros?: number;
    status?: BenchmarkStage["status"];
    command?: string;
    sourceRevision?: string;
  },
  now = new Date(),
) {
  const path = benchmarkPath(options);
  const manifest = readBenchmarkManifest(path);
  manifest[options.variant].stages.push({
    kind: parseStageKind(options.kind),
    label: bounded(options.label, "stage label", 120),
    durationMs: nonNegativeInteger(options.durationMs, "duration-ms"),
    inputTokens: nonNegativeInteger(options.inputTokens ?? 0, "input-tokens"),
    outputTokens: nonNegativeInteger(options.outputTokens ?? 0, "output-tokens"),
    costUsdMicros: nonNegativeInteger(options.costUsdMicros ?? 0, "cost-usd-micros"),
    status: parseStageStatus(options.status ?? "completed"),
    ...(options.command ? { command: bounded(options.command, "command", 500) } : {}),
    ...(options.sourceRevision ? { sourceRevision: bounded(options.sourceRevision, "source revision", 128) } : {}),
  });
  manifest.updatedAt = now.toISOString();
  writeBenchmarkManifest(path, manifest);
  return { path, manifest };
}

export function recordBenchmarkTask(
  options: {
    path?: string;
    cwd?: string;
    variant: BenchmarkVariantKey;
    id: string;
    title: string;
    status?: BenchmarkTaskResult["status"];
    inputTokens: number;
    cacheReadTokens?: number;
    outputTokens: number;
    billableTokens?: number;
    costUsdMicros: number;
    durationMs: number;
    retries?: number;
    qualityScore?: number | null;
  },
  now = new Date(),
) {
  const path = benchmarkPath(options);
  const manifest = readBenchmarkManifest(path);
  const variant = manifest[options.variant];
  const id = bounded(options.id, "task id", 80);
  if (variant.tasks.some((task) => task.id === id)) {
    throw new Error(`Task "${id}" is already recorded for ${options.variant}.`);
  }
  const inputTokens = nonNegativeInteger(options.inputTokens, "input-tokens");
  const cacheReadTokens = nonNegativeInteger(options.cacheReadTokens ?? 0, "cache-read-tokens");
  const outputTokens = nonNegativeInteger(options.outputTokens, "output-tokens");
  variant.tasks.push({
    id,
    title: bounded(options.title, "task title", 500),
    status: parseTaskStatus(options.status ?? "completed"),
    inputTokens,
    cacheReadTokens,
    outputTokens,
    billableTokens: nonNegativeInteger(
      options.billableTokens ?? Math.max(0, inputTokens - cacheReadTokens) + outputTokens,
      "billable-tokens",
    ),
    costUsdMicros: nonNegativeInteger(options.costUsdMicros, "cost-usd-micros"),
    durationMs: nonNegativeInteger(options.durationMs, "duration-ms"),
    retries: nonNegativeInteger(options.retries ?? 0, "retries"),
    qualityScore: qualityScore(options.qualityScore),
  });
  manifest.updatedAt = now.toISOString();
  writeBenchmarkManifest(path, manifest);
  return { path, manifest };
}

export function buildBenchmarkReport(path = DEFAULT_BENCHMARK_PATH, cwd = process.cwd()): BenchmarkReportSnapshot {
  const manifest = readBenchmarkManifest(resolve(cwd, path));
  validateParity(manifest);
  return {
    schemaVersion: 1,
    title: manifest.title,
    summary: manifest.summary,
    repository: manifest.repository,
    methodologyVersion: manifest.methodologyVersion,
    measuredAt: manifest.updatedAt,
    amortizationTaskCount: manifest.amortizationTaskCount,
    prompts: manifest.prompts,
    disclosures: manifest.disclosures,
    baseline: { ...manifest.baseline, metrics: aggregateMetrics(manifest.baseline) },
    candidate: { ...manifest.candidate, metrics: aggregateMetrics(manifest.candidate) },
  };
}

export function benchmarkComparison(report: BenchmarkReportSnapshot) {
  const metrics = [
    ["inputTokens", (value: BenchmarkMetrics) => value.inputTokens],
    ["cacheReadTokens", (value: BenchmarkMetrics) => value.cacheReadTokens],
    ["outputTokens", (value: BenchmarkMetrics) => value.outputTokens],
    ["totalTokens", (value: BenchmarkMetrics) => value.inputTokens + value.outputTokens],
    ["billableTokens", (value: BenchmarkMetrics) => value.billableTokens],
    ["costUsdMicros", (value: BenchmarkMetrics) => value.costUsdMicros],
    ["setupDurationMs", (value: BenchmarkMetrics) => value.setupDurationMs],
    ["refreshDurationMs", (value: BenchmarkMetrics) => value.refreshDurationMs],
    ["taskDurationMs", (value: BenchmarkMetrics) => value.taskDurationMs],
    ["verifyDurationMs", (value: BenchmarkMetrics) => value.verifyDurationMs],
    ["coldStartDurationMs", coldStartDuration],
    ["steadyStateDurationMs", steadyStateDuration],
    [
      "amortizedDurationMs",
      (value: BenchmarkMetrics) =>
        report.amortizationTaskCount == null
          ? null
          : value.setupDurationMs / report.amortizationTaskCount + steadyStateDuration(value),
    ],
    ["attemptedTasks", (value: BenchmarkMetrics) => value.attemptedTasks],
    ["completedTasks", (value: BenchmarkMetrics) => value.completedTasks],
    ["errors", (value: BenchmarkMetrics) => value.errors],
    ["retries", (value: BenchmarkMetrics) => value.retries],
    ["qualityScore", (value: BenchmarkMetrics) => value.qualityScore],
  ] as const;
  return metrics.flatMap(([key, select]) => {
    const baseline = select(report.baseline.metrics);
    const candidate = select(report.candidate.metrics);
    if (baseline == null || candidate == null) return [];
    const difference = candidate - baseline;
    return [
      {
        key,
        baseline,
        candidate,
        difference,
        differencePercent: baseline === 0 ? null : (difference / Math.abs(baseline)) * 100,
      },
    ];
  });
}

export async function uploadBenchmarkReport(options: {
  path?: string;
  cwd?: string;
  configPath?: string;
  destination?: string;
  fetchImpl?: typeof fetch;
}) {
  const report = buildBenchmarkReport(options.path, options.cwd);
  const config = loadCollectorConfig(options.configPath);
  const destination = normalizeDestinationName(options.destination ?? defaultDestinationName(config));
  const target = collectorDestination(config, destination);
  const fetchImpl = options.fetchImpl ?? fetch;
  let accessToken = await resolveCollectorAccessToken(options.configPath, { destination, fetchImpl });
  let response = await postBenchmark(fetchImpl, target.serverUrl, accessToken, report);
  if (response.status === 401 && target.authorization?.type === "oauth") {
    accessToken = await resolveCollectorAccessToken(options.configPath, {
      destination,
      fetchImpl,
      forceRefresh: true,
    });
    response = await postBenchmark(fetchImpl, target.serverUrl, accessToken, report);
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Benchmark upload failed (${response.status}): ${String(body.error ?? "unknown_error")}`);
  }
  return body;
}

export function readBenchmarkManifest(path = DEFAULT_BENCHMARK_PATH): BenchmarkManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read benchmark manifest at ${path}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Unsupported benchmark manifest.");
  return value as BenchmarkManifest;
}

function writeBenchmarkManifest(path: string, manifest: BenchmarkManifest) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function aggregateMetrics(variant: BenchmarkVariantResult): BenchmarkMetrics {
  const stageTotals = variant.stages.reduce(
    (total, stage) => ({
      inputTokens: total.inputTokens + stage.inputTokens,
      outputTokens: total.outputTokens + stage.outputTokens,
      costUsdMicros: total.costUsdMicros + stage.costUsdMicros,
      setupDurationMs: total.setupDurationMs + (stage.kind === "setup" ? stage.durationMs : 0),
      refreshDurationMs: total.refreshDurationMs + (stage.kind === "refresh" ? stage.durationMs : 0),
      verifyDurationMs: total.verifyDurationMs + (stage.kind === "verify" ? stage.durationMs : 0),
      executeDurationMs: total.executeDurationMs + (stage.kind === "execute" ? stage.durationMs : 0),
      errors: total.errors + (stage.status === "failed" ? 1 : 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      costUsdMicros: 0,
      setupDurationMs: 0,
      refreshDurationMs: 0,
      verifyDurationMs: 0,
      executeDurationMs: 0,
      errors: 0,
    },
  );
  const taskTotals = variant.tasks.reduce(
    (total, task) => ({
      inputTokens: total.inputTokens + task.inputTokens,
      cacheReadTokens: total.cacheReadTokens + task.cacheReadTokens,
      outputTokens: total.outputTokens + task.outputTokens,
      billableTokens: total.billableTokens + task.billableTokens,
      costUsdMicros: total.costUsdMicros + task.costUsdMicros,
      durationMs: total.durationMs + task.durationMs,
      completed: total.completed + (task.status === "completed" ? 1 : 0),
      errors: total.errors + (task.status === "error" ? 1 : 0),
      retries: total.retries + task.retries,
    }),
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      billableTokens: 0,
      costUsdMicros: 0,
      durationMs: 0,
      completed: 0,
      errors: 0,
      retries: 0,
    },
  );
  const qualityScores = variant.tasks
    .map((task) => task.qualityScore)
    .filter((score): score is number => score != null);
  return {
    inputTokens: stageTotals.inputTokens + taskTotals.inputTokens,
    cacheReadTokens: taskTotals.cacheReadTokens,
    outputTokens: stageTotals.outputTokens + taskTotals.outputTokens,
    billableTokens: stageTotals.inputTokens + stageTotals.outputTokens + taskTotals.billableTokens,
    costUsdMicros: stageTotals.costUsdMicros + taskTotals.costUsdMicros,
    taskDurationMs: stageTotals.executeDurationMs + taskTotals.durationMs,
    setupDurationMs: stageTotals.setupDurationMs,
    refreshDurationMs: stageTotals.refreshDurationMs,
    verifyDurationMs: stageTotals.verifyDurationMs,
    attemptedTasks: variant.tasks.length,
    completedTasks: taskTotals.completed,
    errors: stageTotals.errors + taskTotals.errors,
    retries: taskTotals.retries,
    qualityScore: qualityScores.length
      ? qualityScores.reduce((total, score) => total + score, 0) / qualityScores.length
      : null,
  };
}

function steadyStateDuration(metrics: BenchmarkMetrics) {
  return metrics.refreshDurationMs + metrics.taskDurationMs + metrics.verifyDurationMs;
}

function coldStartDuration(metrics: BenchmarkMetrics) {
  return metrics.setupDurationMs + steadyStateDuration(metrics);
}

function validateParity(manifest: BenchmarkManifest) {
  if (!manifest.baseline.tasks.length || !manifest.candidate.tasks.length) {
    throw new Error("Record at least one task for both baseline and candidate before comparing.");
  }
  const baseline = manifest.baseline.tasks.map((task) => `${task.id}\0${task.title}`).sort();
  const candidate = manifest.candidate.tasks.map((task) => `${task.id}\0${task.title}`).sort();
  if (JSON.stringify(baseline) !== JSON.stringify(candidate)) {
    throw new Error("Baseline and candidate must contain identical task IDs and titles.");
  }
}

function emptyVariant(input: {
  key: string;
  label: string;
  tool: string;
  configuration: string;
}): BenchmarkVariantResult {
  return {
    key: input.key,
    label: bounded(input.label, "variant label", 120),
    tool: bounded(input.tool, "tool", 120),
    toolVersion: null,
    configuration: bounded(input.configuration, "configuration", 2_000),
    stages: [],
    tasks: [],
  };
}

function normalizeRepositoryUrl(value: string) {
  const trimmed = value
    .trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  const url = new URL(trimmed);
  const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.search ||
    url.hash ||
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error("Benchmark repository must be a canonical public GitHub repository URL.");
  }
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`Could not resolve git ${args.join(" ")}. Pass the repository value explicitly.`);
  }
}

function benchmarkPath(options: { path?: string; cwd?: string }) {
  return resolve(options.cwd ?? process.cwd(), options.path ?? DEFAULT_BENCHMARK_PATH);
}

function bounded(value: string, field: string, max: number) {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > max || hasControlCharacter) {
    throw new Error(`Invalid ${field}.`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
  return value;
}

function positiveIntegerOrNull(value: number | undefined) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error("amortization-task-count must be between 1 and 100000.");
  }
  return value;
}

function qualityScore(value: number | null | undefined) {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("quality-score must be between 0 and 100.");
  return value;
}

function parseStageKind(value: string): BenchmarkStageKind {
  if (BENCHMARK_STAGE_KINDS.includes(value as BenchmarkStageKind)) return value as BenchmarkStageKind;
  throw new Error(`Invalid stage kind "${value}".`);
}

function parseStageStatus(value: string): BenchmarkStage["status"] {
  if (value === "completed" || value === "failed" || value === "skipped") return value;
  throw new Error(`Invalid stage status "${value}".`);
}

function parseTaskStatus(value: string): BenchmarkTaskResult["status"] {
  if (value === "completed" || value === "failed" || value === "error") return value;
  throw new Error(`Invalid task status "${value}".`);
}

async function postBenchmark(
  fetchImpl: typeof fetch,
  serverUrl: string,
  accessToken: string,
  report: BenchmarkReportSnapshot,
) {
  return fetchImpl(`${serverUrl}/api/v1/benchmarks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "x-traice-collector-version": packageMetadata.version,
    },
    body: JSON.stringify(report),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
