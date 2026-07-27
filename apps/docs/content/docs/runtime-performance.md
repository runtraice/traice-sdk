---
title: SDK Runtime Architecture and Performance
excerpt: See client-side request work, caches, batching, measured local latency, limits, and the serverless workaround.
section: Product SDKs
sectionOrder: 2
order: 6
---

# SDK Runtime Architecture and Performance

> Local SDK overhead per tracked LLM call stayed under 1 ms at p99 across our Node.js and Python GCP benchmark matrix with default buffered delivery. Network delivery and opt-in guardrail evaluation are separate.

## Client-side architecture

The SDK performs usage extraction, pricing, attribution, guardrail decisions, and buffering inside the application process. The trAIce platform is an HTTP destination from the SDK's point of view.

```text
Application process

  LLM request
      |
      +--> optional TypeScript guardrail wrapper
      |       |
      |       +--> fresh process-local rule snapshot
      |       +--> local decision: pass, cache, deny, retry cap, or route
      |       +--> provider call when required
      |
      +--> provider response
              |
              +--> extract model and token usage
              +--> calculate cost and attach attribution
              +--> create event
              |
              +--> in-process adapter or queue
                      |
                      +--> batch and serialize
                      +--> HTTPS POST
                              |
                              v
                        trAIce platform
```

The metering and guardrail APIs are separate. `meter()` and `CostMeter.track()` record a provider call. They do not automatically apply active rules. TypeScript applications opt into request enforcement by wrapping the provider call with `CloudAdapter.enforceRequest()`.

### TypeScript request sequence

```text
Node.js event loop

provider call ───────────────> response
                                 |
                                 +-- usage extraction
                                 +-- price calculation
                                 +-- event construction
                                 +-- CloudAdapter.write()
                                        |
                                        +-- below batch limit: append and return
                                        |
                                        +-- at batch limit:
                                            JSON serialization
                                            fetch setup
                                            async network wait
```

The default is `awaitWrites: false`. Event construction and the start of adapter writes still execute on the event-loop thread, but the caller does not wait for the adapter promise. At the default batch size of 50, most writes only append to the in-memory buffer. The write that reaches the threshold starts serialization and upload.

Node worker threads can move CPU-heavy serialization off the event loop, but they add message-transfer overhead and do not improve asynchronous HTTP by themselves. The current TypeScript SDK does not create a worker thread.

### TypeScript guardrail sequence

```text
enforceRequest()
      |
      +-- rules fresh? -- no --> start one background refresh
      |                         pass through to provider
      |
      +-- yes --> sort and evaluate rules locally
                      |
                      +-- no match ---------> provider
                      +-- exact cache hit --> cached response
                      +-- semantic rule ----> customer embedder, then local lookup
                      +-- deny/retry cap ---> local exception
                      +-- route/fallback ---> provider call with rule behavior
```

Active rules are not downloaded on every request and are not polled once per minute. The server-provided snapshot has a 60-second default TTL. The first request after expiry fails open, starts one asynchronous refresh, and continues to the provider. `warmEnforcement()` is the opt-in way to fetch rules before serving traffic.

The separate advisory budget policy uses a 60-second background poll by default. That timer does not replace the lazy active-rule refresh.

### Python request sequence

```text
handler thread                         daemon delivery thread

provider response
      |
      +-- extract usage
      +-- calculate cost
      +-- construct event
      +-- lock and enqueue ----------> wake at 50 events or 5 seconds
      +-- return                      serialize batch
                                      HTTPS POST
```

The Python SDK already offloads batch serialization and network I/O to a daemon thread. Event construction and the short queue lock remain on the calling thread. The Python SDK currently collects telemetry only and does not implement the TypeScript active-rule or response-cache APIs.

## Defaults and limits

| Area                    | TypeScript                                                               | Python                                                   |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Event batch size        | 50                                                                       | 50                                                       |
| Flush interval          | 5 seconds                                                                | 5 seconds                                                |
| Event upload timeout    | 10 seconds                                                               | 10 seconds                                               |
| Queue limit             | No configurable hard event-count limit today                             | 1,000 events; drops oldest when full                     |
| Failed delivery         | Requeues a failed batch when the current buffer is below its retry bound | Retries once after 100 ms, then drops the batch          |
| Active-rule snapshot    | Process-local, server TTL with a 60-second default                       | Not available                                            |
| Exact response cache    | Process-local, 1,000 entries by default                                  | Not available                                            |
| Semantic response cache | Process-local, 250 entries by default; customer-supplied embedder        | Not available                                            |
| Explicit drain          | `flush()`, which also stops CloudAdapter timers                          | `flush(timeout=...)`, or `shutdown()` to stop the worker |

Large prompts, outputs, and metadata increase event construction, memory, and JSON serialization cost. Prompt and output content are optional for attribution. Omit them unless the application needs them.

## Published benchmark results

The summary above is a per-call measurement, not a batch duration. The timed operation starts with an immediate mock provider response and ends after the SDK has extracted usage, calculated price, attached attribution, built an event, and handed that event to its in-process buffer or queue. Because the provider stub returns immediately, the result closely represents the local work added around a normal provider call.

The measurement includes the mock provider invocation instead of subtracting one percentile from another. Provider-only p95 was at most 0.001 ms in JavaScript and 0.0003 ms in Python. Percentiles are not additive, so reporting the complete instrumented operation is less misleading than subtracting independently calculated p95 values.

It excludes real provider latency, rule-refresh network time, background delivery, and event-upload network time. An event is only buffered when this timer stops.

### GCP matrix

Tests ran on July 27, 2026 in `us-central1-a`. Each runtime and machine combination had five independent runs of 20,000 measured events after 2,000 warmup events.

| GCP machine type | vCPU | Memory | Architecture and observed CPU                 |
| ---------------- | ---: | -----: | --------------------------------------------- |
| `e2-medium`      |    2 |   4 GB | x86-64, Intel Xeon at 2.20 GHz                |
| `e2-standard-2`  |    2 |   8 GB | x86-64, Intel Xeon at 2.20 GHz                |
| `c3-standard-4`  |    4 |  16 GB | x86-64, Intel Xeon Platinum 8481C at 2.70 GHz |
| `t2a-standard-2` |    2 |   8 GB | Arm64, Neoverse N1                            |

JavaScript ran on Node.js 20.20.2 and 24.18.0. Python ran on CPython 3.9, 3.12, and 3.14. That produces 40 JavaScript and 60 Python reports per scenario, or 100 reports total.

### Per-event results

The isolated handoff keeps the batch threshold above the sample count. It answers: "How much foreground local work does the SDK add for one event when that event does not trigger a batch?"

| Isolated foreground handoff | p95 range across runs | p99 range across runs | Highest p95 |
| --------------------------- | --------------------: | --------------------: | ----------: |
| JavaScript                  |     0.005 to 0.012 ms |     0.006 to 0.039 ms |    0.012 ms |
| Python                      |     0.011 to 0.032 ms |     0.015 to 0.052 ms |    0.032 ms |

The default-batch load test uses a batch size of 50 and calls the mock provider continuously with no real provider delay. This deliberately exposes serialization tails and, in Python, contention with the delivery thread.

| Sustained default-batch load | p95 range across runs | p99 range across runs | Highest p95 | Highest p99 |
| ---------------------------- | --------------------: | --------------------: | ----------: | ----------: |
| JavaScript                   |     0.003 to 0.014 ms |     0.128 to 0.342 ms |    0.014 ms |    0.342 ms |
| Python                       |     0.011 to 0.170 ms |     0.016 to 0.348 ms |    0.170 ms |    0.348 ms |

These results support a conservative "under 1 ms" summary for local SDK overhead in default buffered mode. In TypeScript, every 50th event starts JSON serialization on the event-loop thread. That 2% path is visible at p99 but usually not p95. Python moves delivery to a daemon thread, but a zero-latency tight loop can contend with that thread on smaller machines. Real LLM calls normally leave much more time between events, but applications should measure their own traffic pattern.

### What the GCP coverage taught us

- **The isolated handoff was consistently small.** It remained below 0.04 ms p95 across JavaScript and Python on x86-64 and Arm64 machines.
- **p95 alone hides the TypeScript batch boundary.** With a batch size of 50, only 2% of events trigger serialization. The default-batch p99 remained below 0.35 ms in both implementations.
- **Python trades caller-thread work for delivery-thread contention.** Its daemon thread keeps serialization and network I/O off the request thread, but a continuous zero-latency loop on smaller machines pushed p95 as high as 0.17 ms.
- **Runtime and machine choice matter most under sustained load.** Isolated results were close across the matrix. Wider variation appeared when application and delivery work competed for CPU.
- **Rules and payloads need separate numbers.** Warm evaluation of 100 non-matching rules remained below 0.02 ms p95, while 1,000 rules remained below 0.17 ms. Large metadata moved whole-batch serialization into the millisecond range.
- **Buffered does not mean delivered.** None of these local measurements include a real upload. `awaitWrites: true` with `batchSize: 1`, or an awaited `flush()`, adds serialization and the actual network round trip.

### How the benchmarks work

Each case is an in-process microbenchmark:

1. Run the operation repeatedly without recording it so runtime initialization and common just-in-time compilation are outside the measured sample.
2. Measure every later operation independently with `performance.now()` in TypeScript or `time.perf_counter()` in Python.
3. Sort the wall-clock samples and report p50, p95, p99, mean, minimum, maximum, and operations per second.
4. Record the runtime version, operating system, architecture, CPU model, iteration count, and warmup count with the result.

The mock provider returns a fixed OpenAI-shaped response immediately. TypeScript replaces `fetch` with an immediate in-memory response. Python uses a no-op transport and creates an isolated `TraiceClient` per scenario. No benchmark contacts the trAIce API.

The measured paths have different meanings:

| Benchmark group                    | Timer includes                                                                                                    | Timer excludes                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Rule planning and warm enforcement | Local sorting, matching, cache bookkeeping, and promise overhead                                                  | Rules download and real provider calls              |
| Isolated per-event handoff         | Mock provider invocation, usage extraction, pricing, attribution, event construction, and buffer or queue handoff | Batch work, real provider latency, and network time |
| Default-batch per-event load       | The isolated path plus caller-thread serialization or delivery-thread contention under sustained load             | Real provider latency and real network time         |
| Buffer or queue append             | In-memory append and synchronization                                                                              | Serialization and upload                            |
| 50-event batch completion          | Enqueuing 50 events, JSON serialization, thread scheduling where applicable, and the mocked transport             | Real network time                                   |
| Single-event delivery-first path   | Event handoff, serialization, thread scheduling where applicable, and the mocked transport                        | Real network time                                   |

The Python batch-completion number is not added directly to a normal request. Its daemon thread wakes, acquires the queue, serializes events, and calls the transport. Scheduling and lock contention can still affect the application thread, which is why the sustained default-batch per-event case is also reported.

| Other measured path                                 |   p95 range across GCP runs |
| --------------------------------------------------- | --------------------------: |
| TypeScript plan, 100 non-matching rules             |           0.002 to 0.010 ms |
| TypeScript plan, 1,000 non-matching rules           |           0.029 to 0.161 ms |
| TypeScript warm enforcement, 100 rules              |           0.005 to 0.018 ms |
| TypeScript cloud buffer append                      |         0.0003 to 0.0044 ms |
| TypeScript 50-event batch, normal metadata          | 0.159 to 1.075 ms per batch |
| Python queue append                                 |         0.0005 to 0.0027 ms |
| Python 50-event background batch, normal metadata   | 0.125 to 0.970 ms per batch |
| TypeScript 50-event batch, 10 KB metadata per event | 0.784 to 3.896 ms per batch |
| Python 50-event background batch, 10 KB per event   | 1.128 to 5.252 ms per batch |

### Latency chart

This chart rounds the highest observed percentile across the GCP matrix. Each `#` is approximately 0.02 ms.

```text
Isolated handoff p95, both SDKs  ##                  <0.04 ms
Default batching p95, both SDKs  #########           <0.18 ms
Default batching p99, both SDKs  ##################  <0.35 ms
```

### Reproduce the benchmark

Run both suites:

```bash
pnpm run benchmark:sdk
```

Run one implementation, change the sample size, or emit JSON:

```bash
pnpm run benchmark:sdk:js -- --iterations 20000 --warmup 2000
pnpm run benchmark:sdk:js -- --json

pnpm run benchmark:sdk:python --iterations 20000 --warmup 2000
pnpm run benchmark:sdk:python --json
```

Review the [TypeScript benchmark source](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/benchmarks/runtime-latency.ts) and [Python benchmark source](https://github.com/runtraice/traice-sdk/blob/main/packages/python/benchmarks/runtime_latency.py). The TypeScript suite covers rule counts, warm enforcement, exact and semantic cache hits, isolated and default-batch event handling, buffer append, normal batches, large-metadata batches, and a delivery-first single-event configuration. The Python suite covers provider baseline, queue append, event construction, isolated and default-batch tracking, normal and large-metadata batches, and a delivery-first single-event configuration.

These numbers are evidence for local overhead, not a customer latency SLO. CPU contention, payload size, runtime version, garbage collection, and operating-system scheduling can change them.

## Where user-visible latency appears

| Work                                    | On the request path?                                                | Main latency source                                        |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Usage extraction, pricing, attribution  | Yes, after the provider returns                                     | Local CPU                                                  |
| Warm active-rule decision               | Yes, before the provider call                                       | Local CPU and rule count                                   |
| Cold or expired active-rule refresh     | No by default; request fails open                                   | Background network request                                 |
| `warmEnforcement()`                     | Yes when the application awaits it                                  | Network round trip                                         |
| Exact cache hit                         | Yes, replaces the provider call                                     | Stable hashing and local map lookup                        |
| Semantic cache check                    | Yes                                                                 | Customer-supplied embedding latency plus local vector scan |
| Buffer append below threshold           | Starts on the request thread                                        | Local array or queue operation                             |
| Batch threshold reached                 | Starts on the request thread in TypeScript; daemon thread in Python | Serialization, then network                                |
| `awaitWrites: true` with `batchSize: 1` | Yes                                                                 | Serialization and full event-upload network round trip     |
| `flush()`                               | Yes when awaited                                                    | Queue drain, serialization, retries, and network           |

## Serverless and Lambda workaround

Lambda is not a durable in-memory runtime, but it can reuse module-scope SDK state inside one warm execution environment. Cold and concurrent environments have independent rule caches, response caches, and event buffers. AWS may freeze unfinished background work after the handler returns.

Create clients outside the handler. This follows [AWS Lambda best practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html) and gives warm invocations the best chance to reuse connections and caches.

### Recommended default: low latency, best effort

- Create one client or adapter in module scope.
- Keep TypeScript `awaitWrites` at its default `false`.
- Do not call `CloudAdapter.flush()` after every invocation because it stops the shared adapter's timers.
- Accept that a frozen or terminated environment can lose buffered events.
- Compare SDK event volume with application request volume so delivery loss is visible.

### Delivery-first TypeScript workaround

Set `batchSize: 1` and await adapter writes. This confirms the upload before the handler returns, but adds the network round trip to invocation latency.

```typescript
import { CloudAdapter, CostMeter } from "@traice/sdk";

const cloud = new CloudAdapter({
  apiKey: process.env.TRAICE_API_KEY!,
  batchSize: 1,
});
const meter = new CostMeter({ adapters: [cloud], provider: "openai" });

export async function handler() {
  return meter.track(() => callModel(), {
    feature: "lambda-handler",
    awaitWrites: true,
  });
}
```

`awaitWrites: true` by itself does not confirm an upload while an event remains below the batch threshold. Use it with `batchSize: 1` when each invocation needs confirmation.

### Warm TypeScript guardrails

Keep the adapter and warmup promise in module scope. Awaiting the promise makes the first invocation in each execution environment pay the rules network cost, while warm invocations reuse the snapshot.

```typescript
import { CloudAdapter } from "@traice/sdk";

const cloud = new CloudAdapter({
  apiKey: process.env.TRAICE_API_KEY!,
});
const rulesReady = cloud.warmEnforcement();

export async function handler() {
  await rulesReady;
  return cloud.enforceRequest(
    { model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] },
    (request) => openai.chat.completions.create(request),
    { feature: "lambda-handler" },
  );
}
```

If fail-open behavior is acceptable, do not await the warmup. The first request starts a background refresh and continues to the provider.

### Delivery-first Python workaround

Create the client in module scope, then use a bounded flush when the remaining invocation time permits:

```python
import os
import traice

traice.configure(os.environ["TRAICE_API_KEY"])


@traice.track(feature="lambda-handler")
def call_model():
    return openai.chat.completions.create(...)


def handler(event, context):
    try:
        return call_model()
    finally:
        traice.flush(timeout=0.25)
```

The flush can add up to the selected timeout. Check its Boolean return value if the application needs to record whether the queue drained.

If the application already operates a lifecycle-aware collector or durable AWS queue, sending telemetry there can separate request latency from delivery. A Node worker thread, Python daemon thread, or ordinary child process inside the function does not by itself prevent Lambda from freezing unfinished work.

## Measure production latency

Compare instrumented and uninstrumented requests in the target runtime. Report at least:

- p50, p95, and p99 handler duration;
- provider time separately from SDK post-processing;
- cold and warm invocations;
- streamed time to first byte;
- event delivery lag, queue depth, drops, and flush time;
- rule count, rule age, and semantic embedding latency when those features are enabled;
- payload size, especially prompt, output, and metadata bytes.

## Related guides

- [TypeScript and Node.js SDK](/docs/typescript-sdk)
- [Python SDK](/docs/python-sdk)
- [Event Contract Reference](/docs/event-reference)
