import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkActivityFromOtlp,
  benchmarkComparison,
  buildBenchmarkReport,
  captureBenchmarkActivityPayload,
  initializeBenchmark,
  recordBenchmarkStage,
  recordBenchmarkTask,
  startBenchmarkActivityCapture,
  stopBenchmarkActivityCapture,
} from "../src/benchmark";
import { buildDefaultConfig, writeCollectorConfig } from "../src/config";

describe("repository benchmarks", () => {
  it("records setup and refresh in all-in A/B totals", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "benchmark.json");
    initializeBenchmark(
      {
        path,
        cwd: directory,
        title: "Graphify vs baseline on Next.js",
        summary: "Repository context comparison.",
        repositoryUrl: "https://github.com/vercel/next.js",
        repositoryRevision: "0123456789abcdef",
        prompts: ["Trace the request flow."],
        amortizationTaskCount: 20,
        candidateLabel: "Graphify",
      },
      new Date("2026-08-02T00:00:00.000Z"),
    );
    recordBenchmarkStage({ path, variant: "candidate", kind: "setup", label: "Graphify bootstrap", durationMs: 8_000 });
    recordBenchmarkStage({ path, variant: "candidate", kind: "refresh", label: "Graphify update", durationMs: 500 });
    recordTask(path, "baseline", { inputTokens: 1_000, outputTokens: 200, durationMs: 10_000, costUsdMicros: 1_000 });
    recordTask(path, "candidate", { inputTokens: 600, outputTokens: 150, durationMs: 6_000, costUsdMicros: 650 });

    const report = buildBenchmarkReport(path);
    expect(report.candidate.metrics).toMatchObject({
      inputTokens: 600,
      outputTokens: 150,
      setupDurationMs: 8_000,
      refreshDurationMs: 500,
      taskDurationMs: 6_000,
    });
    expect(benchmarkComparison(report).find((row) => row.key === "inputTokens")).toMatchObject({
      difference: -400,
      differencePercent: -40,
    });
    expect(benchmarkComparison(report).find((row) => row.key === "coldStartDurationMs")).toMatchObject({
      baseline: 10_000,
      candidate: 14_500,
      difference: 4_500,
      differencePercent: 45,
    });
  });

  it("requires identical tasks and preserves a private local manifest", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "benchmark.json");
    initializeBenchmark({
      path,
      cwd: directory,
      title: "Comparison",
      summary: "Comparison summary",
      repositoryUrl: "https://github.com/vercel/next.js",
      repositoryRevision: "0123456789abcdef",
      prompts: ["Trace the request flow."],
    });
    recordTask(path, "baseline", { inputTokens: 1, outputTokens: 1, durationMs: 1, costUsdMicros: 1 });
    expect(() => buildBenchmarkReport(path)).toThrow("at least one task for both baseline and candidate");
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("outputs");
  });

  it("does not invent a percentage when the baseline is zero", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "benchmark.json");
    initializeBenchmark({
      path,
      cwd: directory,
      title: "Comparison",
      summary: "Comparison summary",
      repositoryUrl: "https://github.com/vercel/next.js",
      repositoryRevision: "0123456789abcdef",
      prompts: ["Trace the request flow."],
    });
    recordTask(path, "baseline", { inputTokens: 0, outputTokens: 0, durationMs: 1, costUsdMicros: 0 });
    recordTask(path, "candidate", { inputTokens: 1, outputTokens: 0, durationMs: 1, costUsdMicros: 0 });
    expect(benchmarkComparison(buildBenchmarkReport(path)).find((row) => row.key === "inputTokens")).toMatchObject({
      difference: 1,
      differencePercent: null,
    });
  });

  it("reduces raw Codex OpenTelemetry tool logs to bounded activity categories", () => {
    expect(benchmarkActivityFromOtlp(toolActivityPayload())).toEqual([
      {
        category: "file_read",
        source: "opentelemetry",
        count: 1,
        durationMs: 12,
        failedCount: 0,
      },
      {
        category: "graph_query",
        source: "opentelemetry",
        count: 1,
        durationMs: 41,
        failedCount: 0,
      },
      {
        category: "repository_search",
        source: "opentelemetry",
        count: 1,
        durationMs: 7,
        failedCount: 1,
      },
    ]);
  });

  it("captures only aggregate activity in the benchmark manifest", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "benchmark.json");
    const configPath = join(directory, "collector", "config.json");
    writeCollectorConfig(buildDefaultConfig(), configPath);
    initializeBenchmark({
      path,
      cwd: directory,
      title: "Comparison",
      summary: "Comparison summary",
      repositoryUrl: "https://github.com/vercel/next.js",
      repositoryRevision: "0123456789abcdef",
      prompts: ["Trace the request flow."],
    });

    startBenchmarkActivityCapture({ path, variant: "candidate", configPath });
    captureBenchmarkActivityPayload(toolActivityPayload(), configPath);
    const result = stopBenchmarkActivityCapture({ configPath });

    expect(result.activity).toHaveLength(3);
    const serialized = readFileSync(path, "utf8");
    expect(serialized).not.toContain("graphify query lifecycle");
    expect(serialized).not.toContain("lib/route.js");
    expect(JSON.parse(serialized).candidate.activity).toEqual(result.activity);
  });
});

function recordTask(
  path: string,
  variant: "baseline" | "candidate",
  values: { inputTokens: number; outputTokens: number; durationMs: number; costUsdMicros: number },
) {
  recordBenchmarkTask({
    path,
    variant,
    id: "trace-flow",
    title: "Trace the request flow",
    status: "completed",
    qualityScore: 90,
    ...values,
  });
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "traice-benchmark-"));
}

function toolActivityPayload() {
  const attribute = (key: string, value: string | number) => ({
    key,
    value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
  });
  const record = (tool: string, args: string, duration: number, success: boolean) => ({
    attributes: [
      attribute("event.name", "codex.tool_result"),
      attribute("tool_name", tool),
      attribute("arguments", args),
      attribute("duration_ms", duration),
      attribute("success", String(success)),
      attribute("output", "private tool output"),
    ],
  });
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              record("exec", '{"cmd":"graphify query lifecycle"}', 41, true),
              record("exec", '{"cmd":"rg route lib"}', 7, false),
              record("exec", '{"cmd":"sed -n 1,80p lib/route.js"}', 12, true),
            ],
          },
        ],
      },
    ],
  };
}
