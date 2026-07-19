---
title: SDK Quickstart
excerpt: Send product-runtime LLM cost events from TypeScript, Python, or any HTTP client.
order: 2
---

# SDK Quickstart

Choose a language. TypeScript is selected by default, and every tab sends the same attribution fields to `/api/v1/events`.

:::language-snippet

```typescript install="npm install @traice/sdk openai"
import OpenAI from "openai";
import { configure, flush, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const openai = new OpenAI();
const completion = await meter(
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    feature: "support-summary",
    userId: "user_123",
    tenantId: "customer_42",
    workflowId: "support",
  },
);

await flush();
```

```python install="pip install traice-sdk openai"
from openai import OpenAI
from traice import configure, flush, track

configure(api_key="lm_live_YOUR_API_KEY")
openai = OpenAI()

@track(
    feature="support-summary",
    user_id="user_123",
    tenant_id="customer_42",
    workflow_id="support",
)
def summarize_ticket():
    return openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Summarize this ticket"}],
    )

completion = summarize_ticket()
flush(timeout=2.0)
```

```curl
curl -X POST "https://runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "feature": "support-summary",
    "userId": "user_123",
    "tenantId": "customer_42",
    "workflowId": "support",
    "promptTokens": 1200,
    "outputTokens": 50,
    "cacheReadTokens": 800,
    "cacheWriteTokens": 0,
    "costUsd": 0.0012
  }'
```

:::

`tenantId` is the key field for customer margin. Pass the customer or account identifier you bill on every product event.

The TypeScript and Python SDKs read model and token usage from the provider response, calculate known-model cost locally, and batch events in the background. Call `flush()` before a short-lived script or serverless invocation exits. Long-running processes flush on an interval and at shutdown.

## Python decorators and context managers

`@track()` works with sync and async functions. When a decorator does not fit, use `track()` as a sync or async context manager and attach the provider response with `span.record()`:

:::language-snippet

```typescript
const completion = await meter(() => openai.responses.create({ model: "gpt-4o-mini", input: "Hello" }), {
  feature: "answer",
  tenantId: "customer_42",
});
```

```python
with track(feature="answer", tenant_id="customer_42") as span:
    completion = span.record(
        openai.responses.create(model="gpt-4o-mini", input="Hello")
    )
```

```curl
curl -X POST "https://runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"provider":"openai","model":"gpt-4o-mini","feature":"answer","tenantId":"customer_42","promptTokens":10,"outputTokens":2,"costUsd":0.0000027}'
```

:::

See [Python SDK](python-sdk) for batching, errors, custom pricing, all attribution dimensions, and LangChain or LangGraph callbacks.

## Request enforcement

Keep one `CloudAdapter` instance for the process and pass opted-in calls through
`cloud.enforceRequest()`. The TypeScript SDK executes the wrapper-v1 actions:
exact cache, deny, retry cap, evidence-gated swap or downgrade, and one-shot
fallback.

Call `await cloud.warmEnforcement()` during startup. Wrapped requests never wait
for a rule API read. A cold or expired rules cache passes through and starts a
background refresh.

Active deny and retry-cap rules throw `TraiceEnforcementError` without calling
the provider. The error has a stable code, action, rule identifier, and
structured reason. Shadow rules, unsupported actions, malformed rules, rule API
errors, and explicit bypasses call the provider normally. Streaming requests
can still be denied or retry-capped, but are never cached.

Use `cloud.getExactCacheStats()` for process-local hits, misses, bypasses, hit
rate, and realized savings. trAIce receives action outcomes and verifiable cost
bases, but not request or response payloads.

Swap and downgrade rules need a current experiment for the exact feature,
source model, and target model. The measured equivalence and quality drop must
meet both rule thresholds. Fallback calls the configured target once after the original
provider call fails. If fallback also fails, the original error is preserved.

## Plan enforcement decisions

The SDK exports a pure `decide(request, rules, context)` function for custom
wrappers and deterministic rule tests. It evaluates state, priority,
conditions, model allowlists, and supplied equivalence evidence without I/O,
then returns `PASS_THROUGH` or a structured active/shadow decision.

Planning does not call a model provider. `CloudAdapter.enforceRequest()` executes
the wrapper-v1 actions. Semantic-cache and route execution remain disabled until
their guarded executors are released.
