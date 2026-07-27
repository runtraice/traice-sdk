import { performance } from "node:perf_hooks";
import process from "node:process";
import { arch, cpus, platform } from "node:os";
import { CloudAdapter, CostMeter, decide, type CostAdapter, type CostEvent, type EnforcementRule } from "../src/index";

type BenchmarkResult = {
  name: string;
  iterations: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  operationsPerSecond: number;
};

type BenchmarkReport = {
  runtime: string;
  platform: string;
  architecture: string;
  cpu: string;
  generatedAt: string;
  iterations: number;
  warmupIterations: number;
  results: BenchmarkResult[];
};

const RESPONSE = {
  object: "chat.completion",
  model: "gpt-4o-mini",
  usage: { prompt_tokens: 400, completion_tokens: 100 },
  choices: [{ message: { role: "assistant", content: "ok" } }],
};

const EVENT: CostEvent = {
  id: "benchmark-event",
  timestamp: "2026-07-26T00:00:00.000Z",
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 400,
  outputTokens: 100,
  totalTokens: 500,
  inputCostUSD: 0.00006,
  outputCostUSD: 0.00006,
  totalCostUSD: 0.00012,
  latencyMs: 25,
  feature: "benchmark",
  tenantId: "benchmark-tenant",
  metadata: { benchmark: true },
};

const LARGE_EVENT: CostEvent = {
  ...EVENT,
  id: "benchmark-large-event",
  metadata: { benchmark: true, payload: "x".repeat(10 * 1024) },
};

class CountingAdapter implements CostAdapter {
  readonly name = "benchmark-counting";
  writes = 0;

  async write(): Promise<void> {
    this.writes++;
  }
}

function rule(overrides: Partial<EnforcementRule> = {}): EnforcementRule {
  return {
    id: "benchmark-rule",
    name: "Benchmark rule",
    state: "ACTIVE",
    priority: 100,
    condition: { type: "always" },
    action: "CACHE_EXACT",
    actionParams: { cacheTtlSec: 300 },
    requireEquivalencePct: null,
    modelAllowlist: [],
    ...overrides,
  };
}

function noMatchRules(count: number): EnforcementRule[] {
  return Array.from({ length: count }, (_, index) =>
    rule({
      id: `no-match-${index}`,
      priority: count - index,
      condition: { type: "feature", equals: `other-${index}` },
    }),
  );
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function summarize(name: string, samples: number[]): BenchmarkResult {
  const sorted = samples.slice().sort((left, right) => left - right);
  const meanMs = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    name,
    iterations: sorted.length,
    meanMs,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    minMs: sorted[0] ?? 0,
    maxMs: sorted.at(-1) ?? 0,
    operationsPerSecond: meanMs > 0 ? 1000 / meanMs : Number.POSITIVE_INFINITY,
  };
}

function measureSync(name: string, iterations: number, warmup: number, operation: () => void): BenchmarkResult {
  for (let index = 0; index < warmup; index++) operation();
  const samples = new Array<number>(iterations);
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    operation();
    samples[index] = performance.now() - startedAt;
  }
  return summarize(name, samples);
}

async function measureAsync(
  name: string,
  iterations: number,
  warmup: number,
  operation: () => Promise<void>,
): Promise<BenchmarkResult> {
  for (let index = 0; index < warmup; index++) await operation();
  const samples = new Array<number>(iterations);
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    await operation();
    samples[index] = performance.now() - startedAt;
  }
  return summarize(name, samples);
}

function positiveIntegerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function printReport(report: BenchmarkReport): void {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`TypeScript SDK runtime benchmark (${report.runtime})`);
  console.log(`${report.platform}/${report.architecture}; ${report.cpu}`);
  console.log(`Iterations: ${report.iterations}; warmup: ${report.warmupIterations}`);
  console.log("");
  console.log(
    ["case", "p50 ms", "p95 ms", "p99 ms", "mean ms", "ops/sec"]
      .map((value, index) => value.padEnd(index === 0 ? 36 : 12))
      .join(""),
  );
  for (const result of report.results) {
    console.log(
      [
        result.name.padEnd(36),
        result.p50Ms.toFixed(4).padEnd(12),
        result.p95Ms.toFixed(4).padEnd(12),
        result.p99Ms.toFixed(4).padEnd(12),
        result.meanMs.toFixed(4).padEnd(12),
        Math.round(result.operationsPerSecond).toString().padEnd(12),
      ].join(""),
    );
  }
}

async function main(): Promise<void> {
  const iterations = positiveIntegerArgument("--iterations", 5_000);
  const warmup = positiveIntegerArgument("--warmup", 500);
  const batchIterations = Math.max(20, Math.floor(iterations / 25));
  const batchWarmup = Math.max(5, Math.floor(warmup / 25));
  const results: BenchmarkResult[] = [];

  const originalFetch = globalThis.fetch;
  let rulesPayload: EnforcementRule[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if ((init?.method ?? "GET") === "GET" && url.endsWith("/rules")) {
      return new Response(
        JSON.stringify({
          enabled: true,
          ttlSeconds: 3_600,
          rules: rulesPayload,
          evidence: [],
          budgets: [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ accepted: 50, dropped: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const cloudAdapters: Array<InstanceType<typeof CloudAdapter>> = [];
  const createWarmedCloud = async (
    rules: EnforcementRule[],
    options: ConstructorParameters<typeof CloudAdapter>[0] = { apiKey: "benchmark-key" },
  ) => {
    rulesPayload = rules;
    const adapter = new CloudAdapter({
      endpoint: "https://benchmark.invalid/api/v1/events",
      flushIntervalMs: 3_600_000,
      ...options,
    });
    cloudAdapters.push(adapter);
    if (!(await adapter.warmEnforcement())) throw new Error("Could not warm benchmark rules");
    return adapter;
  };

  try {
    const plannerRules10 = noMatchRules(10);
    const plannerRules100 = noMatchRules(100);
    const plannerRules1000 = noMatchRules(1_000);
    results.push(
      measureSync("decide_no_match_10_rules", iterations, warmup, () => {
        decide({ model: "gpt-4o-mini", feature: "benchmark" }, plannerRules10);
      }),
      measureSync("decide_no_match_100_rules", iterations, warmup, () => {
        decide({ model: "gpt-4o-mini", feature: "benchmark" }, plannerRules100);
      }),
      measureSync("decide_no_match_1000_rules", iterations, warmup, () => {
        decide({ model: "gpt-4o-mini", feature: "benchmark" }, plannerRules1000);
      }),
    );

    const immediateProvider = async () => RESPONSE;
    results.push(
      await measureAsync("provider_promise_baseline", iterations, warmup, async () => {
        await immediateProvider();
      }),
    );

    const noMatchCloud = await createWarmedCloud(noMatchRules(100));
    results.push(
      await measureAsync("enforce_warm_no_match_100", iterations, warmup, async () => {
        await noMatchCloud.enforceRequest(
          { model: "gpt-4o-mini", messages: [{ role: "user", content: "benchmark" }] },
          immediateProvider,
          { feature: "benchmark" },
        );
      }),
    );

    const exactCloud = await createWarmedCloud([rule()]);
    const exactRequest = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "same benchmark request" }],
      temperature: 0,
    };
    await exactCloud.enforceRequest(exactRequest, immediateProvider, { feature: "benchmark" });
    results.push(
      await measureAsync("enforce_exact_cache_hit", iterations, warmup, async () => {
        await exactCloud.enforceRequest(exactRequest, immediateProvider, { feature: "benchmark" });
      }),
    );

    const semanticVector = Array.from({ length: 128 }, (_, index) => (index === 0 ? 1 : 0));
    const semanticCloud = await createWarmedCloud(
      [
        rule({
          action: "CACHE_SEMANTIC",
          actionParams: { cacheTtlSec: 300, similarityThreshold: 0.92 },
        }),
      ],
      {
        apiKey: "benchmark-key",
        semanticCache: { embed: async () => semanticVector, maxEntries: 250, timeoutMs: 1_000 },
      },
    );
    await semanticCloud.enforceRequest(exactRequest, immediateProvider, {
      feature: "benchmark",
      semanticCacheText: "same benchmark request",
    });
    results.push(
      await measureAsync("enforce_semantic_cache_hit_128d", iterations, warmup, async () => {
        await semanticCloud.enforceRequest(exactRequest, immediateProvider, {
          feature: "benchmark",
          semanticCacheText: "same benchmark request",
        });
      }),
    );

    const countingAdapter = new CountingAdapter();
    const costMeter = new CostMeter({ adapters: [countingAdapter], provider: "openai" });
    results.push(
      await measureAsync("meter_mock_provider_enqueue", iterations, warmup, async () => {
        await costMeter.track(immediateProvider, {
          feature: "benchmark",
          tenantId: "benchmark-tenant",
        });
      }),
    );

    const isolatedHandoffCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: iterations + warmup + 1,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(isolatedHandoffCloud);
    const isolatedHandoffMeter = new CostMeter({
      adapters: [isolatedHandoffCloud],
      provider: "openai",
    });
    results.push(
      await measureAsync("per_event_local_handoff", iterations, warmup, async () => {
        await isolatedHandoffMeter.track(immediateProvider, {
          feature: "benchmark",
          tenantId: "benchmark-tenant",
        });
      }),
    );

    const defaultBatchCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: 50,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(defaultBatchCloud);
    const defaultBatchMeter = new CostMeter({ adapters: [defaultBatchCloud], provider: "openai" });
    results.push(
      await measureAsync("per_event_default_batch", iterations, warmup, async () => {
        await defaultBatchMeter.track(immediateProvider, {
          feature: "benchmark",
          tenantId: "benchmark-tenant",
        });
      }),
    );

    const enqueueCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: iterations + warmup + 1,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(enqueueCloud);
    results.push(
      await measureAsync("cloud_buffer_enqueue", iterations, warmup, async () => {
        await enqueueCloud.write(EVENT);
      }),
    );

    const batchCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: 50,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(batchCloud);
    results.push(
      await measureAsync("cloud_batch_send_50", batchIterations, batchWarmup, async () => {
        for (let index = 0; index < 50; index++) await batchCloud.write(EVENT);
      }),
    );

    const largeBatchCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: 50,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(largeBatchCloud);
    results.push(
      await measureAsync("cloud_batch_send_50_10k_metadata", batchIterations, batchWarmup, async () => {
        for (let index = 0; index < 50; index++) await largeBatchCloud.write(LARGE_EVENT);
      }),
    );

    const singleEventCloud = new CloudAdapter({
      apiKey: "benchmark-key",
      endpoint: "https://benchmark.invalid/api/v1/events",
      batchSize: 1,
      flushIntervalMs: 3_600_000,
    });
    cloudAdapters.push(singleEventCloud);
    results.push(
      await measureAsync("cloud_single_send_mock_transport", iterations, warmup, async () => {
        await singleEventCloud.write(EVENT);
      }),
    );
  } finally {
    await Promise.allSettled(cloudAdapters.map((adapter) => adapter.flush()));
    globalThis.fetch = originalFetch;
  }

  printReport({
    runtime: process.version,
    platform: platform(),
    architecture: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    generatedAt: new Date().toISOString(),
    iterations,
    warmupIterations: warmup,
    results,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
