---
title: Python API Reference
excerpt: Public traice-sdk functions, client lifecycle, tracker, callback handler, and data classes.
section: Reference
sectionOrder: 5
order: 3
---

# Python API Reference

Install the `traice-sdk` distribution and import the package as `traice`. The root entrypoint explicitly defines the supported public surface in [`traice/__init__.py`](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/__init__.py).

```python
from traice import configure, flush, track
```

## Root exports

| API                     | Signature or shape                                                     | Behavior                                                                   | Source                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `configure`             | `(api_key=None, endpoint=DEFAULT_ENDPOINT, **options) -> TraiceClient` | Replace the process-wide client and return the new client                  | [_client.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_client.py)                  |
| `flush`                 | `(timeout=None) -> bool`                                               | Wait for queued and active delivery; return false on timeout               | [_client.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_client.py)                  |
| `shutdown`              | `(timeout=2.0) -> bool`                                                | Clear the global client, flush, and stop its worker thread                 | [_client.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_client.py)                  |
| `track`                 | `(feature=None, **options) -> Tracker`                                 | Create a decorator and sync or async context manager                       | [_tracking.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_tracking.py)              |
| `configure_pricing`     | `(provider, model, *, input_per_million, output_per_million) -> None`  | Add or replace local model pricing                                         | [_pricing.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_pricing.py)                |
| `TraiceClient`          | Background queue and delivery client                                   | Configure, enqueue, record, flush, close, and inspect one client           | [_client.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_client.py)                  |
| `ClientStats`           | Frozen data class                                                      | `enqueued`, `sent`, `dropped`, `failed_batches`, and `queued` counters     | [_client.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_client.py)                  |
| `Tracker`               | Decorator and context manager                                          | Track provider responses and errors without changing the provider result   | [_tracking.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_tracking.py)              |
| `TraiceCallbackHandler` | LangChain-compatible callback handler                                  | Track LLM callback lifecycle and usage without a hard LangChain dependency | [langchain.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/integrations/langchain.py) |
| `__version__`           | String                                                                 | Installed Python package version                                           | [_version.py](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_version.py)                |

## `configure()` options

```python
configure(
    api_key=None,
    endpoint="https://runtraice.com/api/v1/events",
    batch_size=50,
    flush_interval=5.0,
    timeout=10.0,
    max_queue_size=1_000,
)
```

| Parameter        | Type          | Rules                                                                        |
| ---------------- | ------------- | ---------------------------------------------------------------------------- |
| `api_key`        | `str \| None` | Falls back to `TRAICE_API_KEY`; a blank or missing value raises `ValueError` |
| `endpoint`       | `str`         | Accepts a base URL or full `/api/v1/events` URL                              |
| `batch_size`     | `int`         | Must be positive                                                             |
| `flush_interval` | `float`       | Must be positive                                                             |
| `timeout`        | `float`       | Must be positive                                                             |
| `max_queue_size` | `int`         | Must be positive; the oldest event is dropped when full                      |

Reconfiguration swaps the global client under a lock, then closes the previous client with a best-effort flush.

## `track()` and `Tracker`

```python
track(
    feature=None,
    provider=None,
    model=None,
    tenant_id=None,
    user_id=None,
    agent_id=None,
    workflow_id=None,
    run_id=None,
    step_id=None,
    tool_name=None,
    retry_count=None,
    outcome=None,
    metadata=None,
)
```

`track()` accepts additional keyword dimensions and forwards non-null values to `TraiceClient.record()` after snake_case-to-camelCase conversion.

| Tracker operation                                  | Behavior                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `@track(...)`                                      | Wrap a sync or async callable and return its value unchanged |
| `with track(...) as span`                          | Measure one synchronous block                                |
| `async with track(...) as span`                    | Measure one asynchronous block                               |
| `span.record(response, provider=None, model=None)` | Attach a response to a context and return it unchanged       |

Provider errors are re-raised. Tracking failures are swallowed so they cannot replace a provider response or exception.

## `TraiceClient`

| Method    | Signature                                                        | Behavior                                                                 |
| --------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `enqueue` | `(event: dict) -> None`                                          | Append without network I/O; drop the oldest event when the queue is full |
| `record`  | `(usage, *, latency_ms, status="success", **dimensions) -> None` | Build a cloud event, calculate cost, add SDK metadata, and enqueue it    |
| `flush`   | `(timeout=None) -> bool`                                         | Wait until the queue and active send are empty                           |
| `close`   | `(timeout=2.0) -> bool`                                          | Mark the client closing and join its worker thread                       |
| `stats`   | `() -> ClientStats`                                              | Read process-local queue and delivery counters under a lock              |

The worker serializes `{ "events": [...] }`, retries one failed batch once, and then increments dropped and failed-batch counters. It identifies itself with `User-Agent: traice-python/<version>` and `X-Source: traice-python`.

## Usage extraction

The internal usage extractor supports object or mapping responses with current OpenAI and Anthropic usage field names. It records input, output, cache-read, and cache-write token counts where the provider exposes them.

Automatic provider detection can be overridden with `provider` and `model` on the tracker or `span.record()`. Unsupported response shapes produce zero-token custom usage rather than changing the provider result.

Source: [`_usage.py`](https://github.com/runtraice/traice-sdk/blob/main/packages/python/src/traice/_usage.py).

## `TraiceCallbackHandler`

Construct the handler with `feature` plus the same snake_case attribution dimensions accepted by `track()`.

```python
handler = TraiceCallbackHandler(
    feature="research",
    tenant_id="customer_42",
)
```

Public callback methods:

- `on_llm_start()` and `on_chat_model_start()` record the run start time.
- `on_llm_end()` extracts model and token usage from `llm_output` and records success.
- `on_llm_error()` records an error event with zero tokens.

The handler uses a lock around its run-time map and has no hard dependency on LangChain.

## Related guides

- [Python SDK guide](/docs/python-sdk)
- [Event contract reference](/docs/event-reference)
- [Python package source](https://github.com/runtraice/traice-sdk/tree/main/packages/python)
