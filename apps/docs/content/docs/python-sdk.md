---
title: Python SDK
excerpt: Configure collection, track sync or async LLM calls, and send attributed events without blocking requests.
order: 3
---

# Python SDK

The `traice-sdk` distribution provides the Python collection path for OpenAI, Anthropic, LangChain, and LangGraph applications. It imports as `traice`, has no required runtime dependencies, and supports Python 3.9 or newer. PyPI does not support scoped package names, and `traice` is already registered by an unrelated project.

## API

### `configure()`

Call `configure(api_key, endpoint)` once when the process starts. `api_key` falls back to `TRAICE_API_KEY`. The endpoint can be a site base URL or the full `/api/v1/events` URL.

Configuration options:

| Option           | Default        | Behavior                                      |
| ---------------- | -------------- | --------------------------------------------- |
| `batch_size`     | `50`           | Flush when this many events are queued        |
| `flush_interval` | `5.0` seconds  | Maximum normal wait before a background flush |
| `timeout`        | `10.0` seconds | HTTP request timeout                          |
| `max_queue_size` | `1000`         | Bounded in-memory queue size                  |

The SDK uses a daemon thread for HTTP delivery. A failed batch is retried once and then dropped. Network failures do not enter the provider-call path.

### `track()`

Use `@track()` on sync or async functions that return an OpenAI or Anthropic response. The decorator records model, provider, input and output tokens, provider-reported cache tokens, calculated cost, latency, status, and attribution dimensions. It returns the provider response unchanged and re-raises provider errors unchanged.

`track()` also works as a sync or async context manager. Call `span.record(response)` inside the context so the SDK can extract response usage.

### Attribution

| Python argument | Cloud field  | Meaning                              |
| --------------- | ------------ | ------------------------------------ |
| `feature`       | `feature`    | Product feature                      |
| `user_id`       | `userId`     | End user                             |
| `tenant_id`     | `tenantId`   | Paying customer or account           |
| `agent_id`      | `agentId`    | Agent identity                       |
| `workflow_id`   | `workflowId` | Workflow identity                    |
| `run_id`        | `runId`      | One execution                        |
| `step_id`       | `stepId`     | Step within an execution             |
| `tool_name`     | `toolName`   | Tool used by an agent                |
| `retry_count`   | `retryCount` | Retry attempt number                 |
| `outcome`       | `outcome`    | Product or workflow outcome          |
| `metadata`      | `metadata`   | JSON-serializable structured context |

Every Python event includes `metadata.sdk: "python"` and `metadata.sdkVersion` for adoption and version observability. Prompts and model outputs are not collected by the Python SDK.

## Complete example

:::language-snippet

```typescript install="npm install @traice/sdk openai"
import OpenAI from "openai";
import { configure, flush, meter } from "@traice/sdk";

configure({ adapters: ["cloud"], cloudApiKey: process.env.TRAICE_API_KEY });
const openai = new OpenAI();

await meter(() => openai.responses.create({ model: "gpt-4o-mini", input: "Hello" }), {
  feature: "answer",
  tenantId: "customer_42",
  runId: "run_123",
});
await flush();
```

```python install="pip install traice-sdk openai"
import os
from openai import OpenAI
from traice import configure, flush, track

configure(api_key=os.environ["TRAICE_API_KEY"])
openai = OpenAI()

@track(feature="answer", tenant_id="customer_42", run_id="run_123")
def answer():
    return openai.responses.create(model="gpt-4o-mini", input="Hello")

response = answer()
flush(timeout=2.0)
```

```curl
curl -X POST "https://runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"provider":"openai","model":"gpt-4o-mini","feature":"answer","tenantId":"customer_42","runId":"run_123","promptTokens":10,"outputTokens":2,"costUsd":0.0000027}'
```

:::

Call `flush(timeout=2.0)` before a short-lived script or serverless handler exits. Long-running processes flush on the configured interval and receive a best-effort flush at normal interpreter shutdown.

## Custom model pricing

Known OpenAI and Anthropic models use the same bundled per-million-token pricing table as `@traice/sdk`. Unknown models keep their token counts and report zero cost. Use `configure_pricing()` to add an application-specific or fine-tuned model.

## LangChain and LangGraph

`TraiceCallbackHandler` is dependency-free. Pass it through the framework's callback configuration. It reads `llm_output` token usage, model, latency, run ID, and any dimensions supplied to its constructor. LangGraph accepts the same callback configuration.

## Operational checks

`configure()` returns a `TraiceClient`. `client.stats()` returns counts for enqueued, sent, dropped, failed batches, and currently queued events. Use these process-local values for health checks. Collection remains best-effort and does not retry provider calls.

For package-level details and development instructions, see the [`packages/python` README](https://github.com/runtraice/traice-sdk/tree/main/packages/python).
