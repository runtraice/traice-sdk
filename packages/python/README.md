# trAIce Python SDK

The `traice-sdk` distribution records LLM model usage, tokens, cost, latency, status, and product attribution, then sends events to trAIce on a background thread. Provider responses and exceptions pass through unchanged. Its Python import name is `traice`.

## Install

```sh
pip install traice-sdk
```

Python 3.9 or newer is supported. The core package has no runtime dependencies. OpenAI, Anthropic, and LangChain remain optional application dependencies. PyPI does not support scoped package names, and the unrelated `traice` distribution is already registered, so installation uses `traice-sdk` while imports use `traice`.

## Five-minute quickstart

Configure the client once when your process starts:

```python
import os

from traice import configure

configure(
    api_key=os.environ["TRAICE_API_KEY"],
    endpoint="https://runtraice.com/api/v1/events",
)
```

Decorate a sync or async function that returns an OpenAI or Anthropic response:

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

The decorator reads usage from current OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages response shapes. It captures provider-reported cache tokens when present.

## Context manager

Use a context manager when a decorator does not fit. Attach the response with `span.record()` so token usage can be extracted:

```python
from traice import track

with track(feature="answer", tenant_id="customer_42") as span:
    response = span.record(openai.responses.create(model="gpt-4o-mini", input="Hello"))
```

Async context managers are supported too:

```python
async with track(feature="answer", tenant_id="customer_42") as span:
    response = span.record(await async_openai.responses.create(model="gpt-4o-mini", input="Hello"))
```

## Attribution dimensions

`track()` accepts the same collection dimensions as `@traice/sdk`:

| Python argument | Event field  | Use                                  |
| --------------- | ------------ | ------------------------------------ |
| `feature`       | `feature`    | Product feature or request path      |
| `user_id`       | `userId`     | End user                             |
| `tenant_id`     | `tenantId`   | Paying customer or account           |
| `agent_id`      | `agentId`    | Agent identity                       |
| `workflow_id`   | `workflowId` | Workflow identity                    |
| `run_id`        | `runId`      | One workflow or agent execution      |
| `step_id`       | `stepId`     | Step within a run                    |
| `tool_name`     | `toolName`   | Tool used by an agent                |
| `retry_count`   | `retryCount` | Retry attempt number                 |
| `outcome`       | `outcome`    | Product or workflow outcome          |
| `metadata`      | `metadata`   | JSON-serializable structured context |

`metadata.sdk` is always `python` and `metadata.sdkVersion` contains the package version.

## Batching and shutdown

Events are appended to a bounded in-memory queue. A daemon thread sends batches every five seconds or when 50 events accumulate. A failed batch is retried once, then dropped. Collection failures do not enter the application request path.

Tune this behavior at startup:

```python
configure(
    api_key=os.environ["TRAICE_API_KEY"],
    batch_size=100,
    flush_interval=2.0,
    timeout=5.0,
    max_queue_size=5_000,
)
```

The SDK registers an `atexit` flush. Explicitly flush short-lived scripts and serverless handlers:

```python
from traice import flush

flush(timeout=2.0)
```

`configure()` returns a `TraiceClient`. Call `client.stats()` to inspect enqueued, sent, dropped, failed-batch, and queued counts.

## Errors

Provider exceptions are re-raised unchanged. The SDK queues an error event with zero tokens, measured latency, and a truncated error message in metadata.

Calling `track()` before `configure()` leaves the provider call unchanged and records nothing. `configure()` rejects a missing API key immediately. It uses `TRAICE_API_KEY` when `api_key` is omitted.

## Custom endpoint and pricing

`endpoint` accepts either the site base URL or the full `/api/v1/events` URL. Unknown models are sent with `costUsd: 0` while their token counts remain intact. Add local pricing in USD per million tokens:

```python
from traice import configure_pricing

configure_pricing(
    "openai",
    "my-fine-tuned-model",
    input_per_million=1.25,
    output_per_million=5.0,
)
```

## LangChain and LangGraph

The callback handler has no hard LangChain dependency:

```python
from traice.integrations import TraiceCallbackHandler

handler = TraiceCallbackHandler(feature="research", tenant_id="customer_42")
result = chain.invoke({"topic": "unit economics"}, config={"callbacks": [handler]})
```

The handler captures the token usage and model information that LangChain exposes through `llm_output`. LangGraph accepts the same callback configuration.

## Privacy

The SDK sends usage metadata, attribution dimensions, and error text. It does not send prompts or model outputs. Do not place secrets or sensitive content in attribution fields or metadata.

## Development

Run the dependency-free test suite:

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
```

Build the package with `python -m build`. Release artifacts are source distributions and universal Python wheels.
