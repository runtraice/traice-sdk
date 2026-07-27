"""Dependency-free latency benchmark for the Python collection runtime."""

import argparse
import gc
import json
import platform
import statistics
import time
from dataclasses import dataclass
from typing import Any, Callable

import traice
from traice._client import TraiceClient
from traice._usage import extract_usage


RESPONSE = {
    "object": "chat.completion",
    "model": "gpt-4o-mini",
    "usage": {"prompt_tokens": 400, "completion_tokens": 100},
    "choices": [{"message": {"role": "assistant", "content": "ok"}}],
}

EVENT = {
    "ts": "2026-07-26T00:00:00.000Z",
    "provider": "openai",
    "model": "gpt-4o-mini",
    "promptTokens": 400,
    "outputTokens": 100,
    "totalTokens": 500,
    "costUsd": 0.00012,
    "latencyMs": 25,
    "feature": "benchmark",
    "tenantId": "benchmark-tenant",
    "metadata": {"benchmark": True},
}

LARGE_EVENT = {
    **EVENT,
    "metadata": {"benchmark": True, "payload": "x" * (10 * 1024)},
}


@dataclass(frozen=True)
class BenchmarkResult:
    name: str
    iterations: int
    mean_ms: float
    p50_ms: float
    p95_ms: float
    p99_ms: float
    min_ms: float
    max_ms: float
    operations_per_second: float


class NoopTransport:
    def __init__(self) -> None:
        self.calls = 0
        self.bytes = 0

    def __call__(self, url: str, body: bytes, headers: Any, timeout: float) -> None:
        self.calls += 1
        self.bytes += len(body)


def percentile(sorted_samples: list[float], quantile: float) -> float:
    if not sorted_samples:
        return 0.0
    index = min(len(sorted_samples) - 1, max(0, int(len(sorted_samples) * quantile + 0.999999) - 1))
    return sorted_samples[index]


def summarize(name: str, samples: list[float]) -> BenchmarkResult:
    samples.sort()
    mean_ms = statistics.fmean(samples)
    return BenchmarkResult(
        name=name,
        iterations=len(samples),
        mean_ms=mean_ms,
        p50_ms=percentile(samples, 0.50),
        p95_ms=percentile(samples, 0.95),
        p99_ms=percentile(samples, 0.99),
        min_ms=samples[0],
        max_ms=samples[-1],
        operations_per_second=1000.0 / mean_ms if mean_ms > 0 else float("inf"),
    )


def measure(name: str, iterations: int, warmup: int, operation: Callable[[], None]) -> BenchmarkResult:
    for _ in range(warmup):
        operation()
    samples: list[float] = []
    for _ in range(iterations):
        started_at = time.perf_counter()
        operation()
        samples.append((time.perf_counter() - started_at) * 1000.0)
    return summarize(name, samples)


def close_client(client: TraiceClient) -> None:
    if not client.close(timeout=5.0):
        raise RuntimeError("benchmark client did not stop")
    gc.collect()


def print_report(iterations: int, warmup: int, results: list[BenchmarkResult], as_json: bool) -> None:
    report = {
        "runtime": platform.python_version(),
        "platform": platform.system().lower(),
        "architecture": platform.machine(),
        "cpu": platform.processor() or "unknown",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "iterations": iterations,
        "warmupIterations": warmup,
        "results": [
            {
                "name": result.name,
                "iterations": result.iterations,
                "meanMs": result.mean_ms,
                "p50Ms": result.p50_ms,
                "p95Ms": result.p95_ms,
                "p99Ms": result.p99_ms,
                "minMs": result.min_ms,
                "maxMs": result.max_ms,
                "operationsPerSecond": result.operations_per_second,
            }
            for result in results
        ],
    }
    if as_json:
        print(json.dumps(report, indent=2))
        return

    print(f"Python SDK runtime benchmark ({report['runtime']})")
    print(f"{report['platform']}/{report['architecture']}; {report['cpu']}")
    print(f"Iterations: {iterations}; warmup: {warmup}")
    print()
    print(f"{'case':36}{'p50 ms':12}{'p95 ms':12}{'p99 ms':12}{'mean ms':12}{'ops/sec':12}")
    for result in results:
        print(
            f"{result.name:36}"
            f"{result.p50_ms:<12.4f}"
            f"{result.p95_ms:<12.4f}"
            f"{result.p99_ms:<12.4f}"
            f"{result.mean_ms:<12.4f}"
            f"{round(result.operations_per_second):<12}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=5_000)
    parser.add_argument("--warmup", type=int, default=500)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    if args.iterations < 1 or args.warmup < 1:
        parser.error("--iterations and --warmup must be positive")

    capacity = args.iterations + args.warmup + 100
    usage = extract_usage(RESPONSE)
    results: list[BenchmarkResult] = []

    results.append(measure("provider_call_baseline", args.iterations, args.warmup, lambda: RESPONSE))

    enqueue_transport = NoopTransport()
    enqueue_client = TraiceClient(
        "benchmark-key",
        batch_size=capacity,
        flush_interval=3_600,
        max_queue_size=capacity,
        _transport=enqueue_transport,
    )
    results.append(
        measure("queue_enqueue", args.iterations, args.warmup, lambda: enqueue_client.enqueue(EVENT))
    )
    close_client(enqueue_client)

    record_transport = NoopTransport()
    record_client = TraiceClient(
        "benchmark-key",
        batch_size=capacity,
        flush_interval=3_600,
        max_queue_size=capacity,
        _transport=record_transport,
    )
    results.append(
        measure(
            "record_event_enqueue",
            args.iterations,
            args.warmup,
            lambda: record_client.record(
                usage,
                latency_ms=25,
                feature="benchmark",
                tenant_id="benchmark-tenant",
            ),
        )
    )
    close_client(record_client)

    tracking_transport = NoopTransport()
    traice.configure(
        "benchmark-key",
        batch_size=capacity,
        flush_interval=3_600,
        max_queue_size=capacity,
        _transport=tracking_transport,
    )

    @traice.track(feature="benchmark", tenant_id="benchmark-tenant")
    def tracked_provider() -> dict[str, Any]:
        return RESPONSE

    results.append(measure("per_event_local_handoff", args.iterations, args.warmup, tracked_provider))
    if not traice.shutdown(timeout=5.0):
        raise RuntimeError("global benchmark client did not stop")
    gc.collect()

    default_batch_tracking_transport = NoopTransport()
    traice.configure(
        "benchmark-key",
        batch_size=50,
        flush_interval=3_600,
        max_queue_size=capacity,
        _transport=default_batch_tracking_transport,
    )

    @traice.track(feature="benchmark", tenant_id="benchmark-tenant")
    def default_batch_tracked_provider() -> dict[str, Any]:
        return RESPONSE

    results.append(
        measure("per_event_default_batch", args.iterations, args.warmup, default_batch_tracked_provider)
    )
    if not traice.shutdown(timeout=5.0):
        raise RuntimeError("default-batch global benchmark client did not stop")
    gc.collect()

    batch_transport = NoopTransport()
    batch_client = TraiceClient(
        "benchmark-key",
        batch_size=50,
        flush_interval=3_600,
        max_queue_size=1_000,
        _transport=batch_transport,
    )

    def send_batch() -> None:
        for _ in range(50):
            batch_client.enqueue(EVENT)
        if not batch_client.flush(timeout=5.0):
            raise RuntimeError("benchmark batch flush timed out")

    batch_iterations = max(20, args.iterations // 25)
    batch_warmup = max(5, args.warmup // 25)
    results.append(measure("thread_batch_send_50", batch_iterations, batch_warmup, send_batch))
    close_client(batch_client)

    large_batch_transport = NoopTransport()
    large_batch_client = TraiceClient(
        "benchmark-key",
        batch_size=50,
        flush_interval=3_600,
        max_queue_size=1_000,
        _transport=large_batch_transport,
    )

    def send_large_batch() -> None:
        for _ in range(50):
            large_batch_client.enqueue(LARGE_EVENT)
        if not large_batch_client.flush(timeout=5.0):
            raise RuntimeError("large benchmark batch flush timed out")

    results.append(
        measure("thread_batch_send_50_10k_metadata", batch_iterations, batch_warmup, send_large_batch)
    )
    close_client(large_batch_client)

    single_transport = NoopTransport()
    single_client = TraiceClient(
        "benchmark-key",
        batch_size=1,
        flush_interval=3_600,
        max_queue_size=1_000,
        _transport=single_transport,
    )

    def send_single() -> None:
        single_client.enqueue(EVENT)
        if not single_client.flush(timeout=5.0):
            raise RuntimeError("single-event benchmark flush timed out")

    results.append(measure("thread_single_send_mock_transport", args.iterations, args.warmup, send_single))
    close_client(single_client)

    print_report(args.iterations, args.warmup, results, args.json)


if __name__ == "__main__":
    main()
