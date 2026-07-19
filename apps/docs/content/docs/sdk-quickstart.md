---
title: Product SDKs
excerpt: Choose the TypeScript SDK, Python SDK, or HTTP API for product-runtime cost attribution.
section: Product SDKs
sectionOrder: 2
order: 1
---

# Product SDKs

Use a product integration when your application calls an LLM on behalf of a customer or end user. Every integration sends the same attribution dimensions to `/api/v1/events`, but installation, usage extraction, cost calculation, and delivery differ by runtime.

## Choose an integration

| Integration                                    | Best for                                                                             | Usage extraction                     | Delivery                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------- |
| [TypeScript and Node.js](/docs/typescript-sdk) | Node.js services, Next.js, Express, streams, adapters, and active request guardrails | OpenAI and Anthropic response shapes | Configurable adapters, including batched cloud delivery |
| [Python](/docs/python-sdk)                     | Python services, scripts, OpenAI, Anthropic, LangChain, and LangGraph                | OpenAI and Anthropic response shapes | Bounded background queue with batched cloud delivery    |
| [HTTP and cURL](/docs/http-api)                | Other runtimes or existing telemetry pipelines                                       | Supplied by your application         | Your application owns delivery and retries              |

The TypeScript SDK requires Node.js 20.9 or newer. The Python SDK requires Python 3.9 or newer and has no required runtime dependencies.

## Send a first event

TypeScript is selected by default. Choose the tab for your runtime.

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
import os

from openai import OpenAI
from traice import configure, flush, track

configure(api_key=os.environ["TRAICE_API_KEY"])
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
curl -X POST "https://www.runtraice.com/api/v1/events" \
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

## Shared attribution fields

| Dimension    | Purpose                         | Example             |
| ------------ | ------------------------------- | ------------------- |
| `tenantId`   | Paying customer or account      | `customer_42`       |
| `userId`     | End user                        | `user_123`          |
| `feature`    | Product feature or request path | `support-summary`   |
| `workflowId` | Workflow definition             | `support`           |
| `runId`      | One workflow or agent execution | `run_01J...`        |
| `stepId`     | Step within a run               | `retrieve-context`  |
| `agentId`    | Agent identity                  | `support-agent`     |
| `toolName`   | Tool used by an agent           | `search-tickets`    |
| `retryCount` | Retry attempt number            | `1`                 |
| `outcome`    | Product or workflow result      | `resolved`          |
| `metadata`   | Additional structured context   | `{ "plan": "pro" }` |

Pass `tenantId` on every customer-facing event. Missing customer attribution prevents customer-level margin analysis.

## Cost and delivery behavior

The TypeScript and Python SDKs extract token usage from supported provider responses and calculate known-model cost locally. Unknown models keep their token counts and use zero cost until you configure local pricing.

Both SDKs are designed to keep collection failures out of the provider-call result. Explicitly flush short-lived scripts, jobs, and serverless handlers before the process exits. The HTTP integration leaves extraction, pricing, batching, retries, and shutdown behavior to your application.

## Continue with one language

- [TypeScript and Node.js guide](/docs/typescript-sdk)
- [Python guide](/docs/python-sdk)
- [HTTP and cURL guide](/docs/http-api)
- [API reference](/docs/api-reference)
