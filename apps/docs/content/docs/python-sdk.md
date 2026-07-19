---
title: Python SDK
excerpt: Configure collection, track sync or async LLM calls, and send attributed events without blocking requests.
section: Product SDKs
sectionOrder: 2
order: 3
---

# Python SDK

The `traice-sdk` distribution records LLM usage, cost, latency, status, and product attribution from Python applications. It imports as `traice`, supports Python 3.9 or newer, and has no required runtime dependencies.

The SDK supports current OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, LangChain, and LangGraph response shapes. Provider SDKs remain optional dependencies owned by your application.

## Install

```python
# requirements.txt
traice-sdk
openai
```

Install the requirements with your normal Python package workflow:

```bash
python -m pip install -r requirements.txt
```

PyPI does not support scoped package names, and the unrelated `traice` distribution is already registered. Install `traice-sdk` and import `traice`.

## Configure the client

Call `configure()` once when the process starts. The API key falls back to `TRAICE_API_KEY`. The endpoint can be the trAIce site base URL or the full `/api/v1/events` URL.

```python
import os

from traice import configure

client = configure(
    api_key=os.environ["TRAICE_API_KEY"],
    endpoint="https://www.runtraice.com",
)
```

Configuration options:

| Option           | Default        | Behavior                                                  |
| ---------------- | -------------- | --------------------------------------------------------- |
| `batch_size`     | `50`           | Wake the delivery worker when this many events are queued |
| `flush_interval` | `5.0` seconds  | Maximum normal wait before a background flush             |
| `timeout`        | `10.0` seconds | HTTP request timeout                                      |
| `max_queue_size` | `1000`         | Maximum number of events held in memory                   |

Reconfiguring replaces the process-wide client after a best-effort close of the previous client.

## Track an OpenAI call

Use `@track()` on a synchronous or asynchronous function that returns a provider response. The provider response passes through unchanged.

```python
from openai import OpenAI
from traice import track

openai = OpenAI()

@track(
    feature="support-summary",
    tenant_id="customer_42",
    user_id="user_123",
    workflow_id="support",
)
def summarize_ticket():
    return openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Summarize this ticket"}],
    )

completion = summarize_ticket()
```

Async functions use the same decorator:

```python
from openai import AsyncOpenAI
from traice import track

openai = AsyncOpenAI()

@track(feature="answer", tenant_id="customer_42")
async def answer_question():
    return await openai.responses.create(
        model="gpt-4o-mini",
        input="Answer this customer question",
    )
```

## Track an Anthropic call

The tracker detects Anthropic Messages responses and provider-reported cache reads and writes.

```python
from anthropic import Anthropic
from traice import track

anthropic = Anthropic()

@track(feature="draft-reply", tenant_id="customer_42")
def draft_reply():
    return anthropic.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        messages=[{"role": "user", "content": "Draft a concise reply"}],
    )
```

## Use a context manager

Use a context manager when a decorator does not fit. Attach the provider response with `span.record()` so the SDK can extract usage. Sync and async contexts are both supported.

```python
from traice import track

with track(feature="answer", tenant_id="customer_42") as span:
    response = span.record(
        openai.responses.create(model="gpt-4o-mini", input="Hello")
    )
```

```python
async with track(feature="answer", tenant_id="customer_42") as span:
    response = span.record(
        await openai.responses.create(model="gpt-4o-mini", input="Hello")
    )
```

Pass `provider` or `model` to `span.record()` when a custom response does not expose enough information for automatic detection.

## Attribution arguments

Python uses snake_case arguments and converts them to the shared cloud fields.

| Python argument | Cloud field  | Meaning                              |
| --------------- | ------------ | ------------------------------------ |
| `feature`       | `feature`    | Product feature or request path      |
| `user_id`       | `userId`     | End user                             |
| `tenant_id`     | `tenantId`   | Paying customer or account           |
| `agent_id`      | `agentId`    | Agent identity                       |
| `workflow_id`   | `workflowId` | Workflow identity                    |
| `run_id`        | `runId`      | One workflow or agent execution      |
| `step_id`       | `stepId`     | Step within an execution             |
| `tool_name`     | `toolName`   | Tool used by an agent                |
| `retry_count`   | `retryCount` | Retry attempt number                 |
| `outcome`       | `outcome`    | Product or workflow result           |
| `metadata`      | `metadata`   | JSON-serializable structured context |

Every Python event adds `metadata.sdk: "python"` and the installed package version as `metadata.sdkVersion`. The SDK does not send prompts or model outputs.

## Flush and shutdown

Events enter a bounded in-memory queue. A daemon thread sends batches on the configured interval or when the batch size is reached. A failed batch is retried once, then counted as dropped. Network failures do not enter the provider-call path.

Explicitly flush short-lived scripts and serverless handlers:

```python
from traice import flush

delivered = flush(timeout=2.0)
```

`flush()` returns `False` when the timeout expires. The SDK also registers a best-effort flush at normal interpreter shutdown. Call `shutdown(timeout=2.0)` when your application owns an explicit lifecycle hook.

## Inspect client health

`configure()` returns a `TraiceClient`. Its process-local statistics distinguish successful delivery from drops.

```python
stats = client.stats()

print(stats.enqueued)
print(stats.sent)
print(stats.dropped)
print(stats.failed_batches)
print(stats.queued)
```

The queue drops the oldest event when `max_queue_size` is reached. Collection remains best-effort and never retries a provider request.

## Errors

Provider exceptions are re-raised unchanged. The tracker queues an error event with zero tokens, measured latency, and a truncated error message in metadata.

Calling `track()` before `configure()` leaves the provider call unchanged and records nothing. `configure()` rejects a missing API key or invalid positive queue and timeout values immediately.

## Custom model pricing

Known OpenAI and Anthropic models use bundled per-million-token pricing. Unknown models retain their token counts and report zero cost. Add or replace local pricing for application-specific models:

```python
from traice import configure_pricing

configure_pricing(
    "openai",
    "my-fine-tuned-model",
    input_per_million=1.25,
    output_per_million=5.0,
)
```

Pricing values must be non-negative.

## LangChain and LangGraph

`TraiceCallbackHandler` does not import LangChain, so the core package remains dependency-free. Pass the handler through the framework callback configuration.

```python
from traice.integrations import TraiceCallbackHandler

handler = TraiceCallbackHandler(
    feature="research",
    tenant_id="customer_42",
)

result = chain.invoke(
    {"topic": "unit economics"},
    config={"callbacks": [handler]},
)
```

The handler reads model and token information exposed through `llm_output`. LangGraph accepts the same callback configuration.

## Reference and source

- [Python API reference](/docs/python-reference)
- [Package on PyPI](https://pypi.org/project/traice-sdk/)
- [Python package source](https://github.com/runtraice/traice-sdk/tree/main/packages/python)
- [Python README](https://github.com/runtraice/traice-sdk/blob/main/packages/python/README.md)
