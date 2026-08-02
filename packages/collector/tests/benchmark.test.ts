import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  benchmarkComparison,
  buildBenchmarkReport,
  initializeBenchmark,
  recordBenchmarkStage,
  recordBenchmarkTask,
} from "../src/benchmark";

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
