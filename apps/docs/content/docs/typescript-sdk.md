---
title: TypeScript and Node.js SDK
excerpt: Meter provider calls and streams, select delivery adapters, and enforce active request rules in Node.js applications.
section: Product SDKs
sectionOrder: 2
order: 2
---

# TypeScript and Node.js SDK

`@traice/sdk` records provider usage, calculates known-model cost, adds product attribution, and writes events through one or more adapters. It supports ES modules and CommonJS on Node.js 20.9 or newer.

## Install

```bash
npm install @traice/sdk openai
```

Provider SDKs, LangChain, and OpenTelemetry are optional peer dependencies. Install only the integrations your application uses.

## Configure cloud delivery

Configure the global meter once during application startup.

```typescript
import { configure } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});
```

`configure()` merges values into the current process-wide configuration. Call `resetConfig()` first when you need a clean configuration, primarily in tests.

## Meter an OpenAI call

`meter()` returns the provider response unchanged. It records provider, model, input and output tokens, provider-reported cache usage, calculated cost, latency, status, and supplied attribution.

```typescript
import OpenAI from "openai";
import { meter } from "@traice/sdk";

const openai = new OpenAI();

const completion = await meter(
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    feature: "support-summary",
    tenantId: "customer_42",
    userId: "user_123",
    workflowId: "support",
  },
);
```

By default, adapter writes are fire-and-forget. Set `awaitWrites: true` on a call when delivery must finish before `meter()` resolves.

## Meter an Anthropic call

Anthropic Messages responses are detected automatically, including cache read and cache creation tokens.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { meter } from "@traice/sdk";

const anthropic = new Anthropic();

const message = await meter(
  () =>
    anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: "Draft a concise reply" }],
    }),
  {
    feature: "draft-reply",
    tenantId: "customer_42",
  },
);
```

## Meter AI SDK and Vertex calls

Pass an explicit provider identifier when the response shape does not identify its provider. The SDK reads camelCase AI SDK usage from `usage` or `totalUsage`, including cache-read tokens.

```typescript
import { meter } from "@traice/sdk";

const result = await meter(() => callVertexModel(), {
  provider: "google-vertex",
  feature: "answer-question",
  tenantId: "customer_42",
});
```

Set `provider` to the stable identifier your pricing configuration and trAIce workspace use. `provider` also acts as the provider hint for streaming calls.

## Meter a stream

`meterStream()` returns the async iterable immediately and records usage after the stream completes. Consume the stream fully so its terminal usage information can be observed.

```typescript
import { meterStream } from "@traice/sdk";

const stream = await meterStream(
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }),
  {
    feature: "chat",
    tenantId: "customer_42",
    userId: "user_123",
  },
);

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

## Attribution options

| Option                        | Meaning                                          |
| ----------------------------- | ------------------------------------------------ |
| `provider`                    | Explicit provider identifier or stream hint      |
| `feature`                     | Product feature or request path                  |
| `tenantId`                    | Paying customer or account                       |
| `userId`                      | End user                                         |
| `agentId`                     | Agent identity                                   |
| `workflowId`                  | Workflow identity                                |
| `runId`                       | One workflow or agent execution                  |
| `stepId`                      | Step within an execution                         |
| `toolName`                    | Tool used by an agent                            |
| `retryCount`                  | Retry attempt number                             |
| `outcome`                     | Product or workflow result                       |
| `sessionId`                   | Application session                              |
| `env`                         | Environment label                                |
| `metadata`                    | Arbitrary structured context                     |
| `tags`                        | Legacy string key/value metadata                 |
| `promptName`, `promptVersion` | Versioned prompt identifiers                     |
| `prompt`, `output`            | Optional sample content when explicitly approved |

Pass `tenantId` on customer-facing calls to support customer-level AI contribution margin.

## Choose adapters

| Adapter   | Behavior                              | Typical use                    |
| --------- | ------------------------------------- | ------------------------------ |
| `cloud`   | Batch product events to trAIce        | Production attribution         |
| `console` | Print events to stdout                | Local inspection               |
| `local`   | Append newline-delimited JSON to disk | Local analysis and CLI reports |
| `webhook` | POST events to your endpoint          | Custom telemetry pipelines     |
| `otel`    | Emit OpenTelemetry metrics            | Existing observability stacks  |

Use adapter names for default construction or pass adapter instances for explicit configuration.

```typescript
import { CloudAdapter, LocalAdapter, configure } from "@traice/sdk";

const cloud = new CloudAdapter({
  apiKey: process.env.TRAICE_API_KEY!,
  batchSize: 100,
  flushIntervalMs: 2_000,
});

configure({
  adapters: [cloud, new LocalAdapter("./.traice-costs/events.ndjson")],
});
```

## Flush before exit

Call `flush()` before a short-lived process, job, or serverless invocation exits. It waits for pending writes and adapter buffers.

```typescript
import { flush } from "@traice/sdk";

await flush();
```

Use `getMeterStats()` to inspect tracked events, dropped events, adapter errors, and unknown models for the current process.

## Framework integrations

The package exports helpers for Express, Next.js, and LangChain:

- `createExpressMiddleware()` attaches prefilled `req.meter()` and `req.meterStream()` helpers.
- `withCostTracking()` wraps a Next.js App Router Route Handler.
- `withMeteredAction()` wraps a Next.js Server Action.
- `createNextApiHandler()` wraps a Pages Router API handler.
- `LangChainCostHandler` records LLM callback usage exposed by LangChain.

These helpers use the same global SDK configuration and attribution model as `meter()`.

## Advisory workspace budgets

Use cloud budget policy when your application should remain the final decision
maker. Warm it once during startup; the request path then reads memory only.

```typescript
const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
await cloud.warmPolicy();

const budget = cloud.getBudgetAdvice({
  feature: "support-summary",
  userId: currentUser.id,
});

if (budget.isBlocked) return fallbackWithoutAnLlm();
const model = budget.shouldDowngrade ? "gpt-4o-mini" : "gpt-4o";
const response = await openai.chat.completions.create({ model, messages });
```

`shouldDowngrade()` uses the 80% warning threshold and `isBlocked()` uses the
100% exceeded threshold across matching workspace, feature, and user budgets.
Both are advisory: your code chooses the fallback or model. A cold, expired,
or failed cache returns false and refreshes asynchronously, so this path is
fail-open and adds no policy network read to the call.

Use `getBudgetAdvice()` when you need the matching scopes, utilization, or
reason, and `getEnforcementStats()` to observe policy refresh failures and
fail-open checks.

## Active request enforcement

`CloudAdapter.enforceRequest()` executes supported active request rules for an explicitly wrapped path: exact cache, deny, retry cap, evidence-gated swap or downgrade, and one-shot fallback.

Keep one adapter for the process and warm its rules before serving traffic. A cold or expired rules cache passes through and refreshes in the background.

```typescript
import { CloudAdapter, TraiceEnforcementError } from "@traice/sdk";

const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
await cloud.warmEnforcement();

const request = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Summarize this ticket" }],
  temperature: 0,
};

try {
  const response = await cloud.enforceRequest(
    request,
    (effectiveRequest) => openai.chat.completions.create(effectiveRequest),
    { feature: "support-summary", retryCount: 0, provider: "openai" },
  );
} catch (error) {
  if (error instanceof TraiceEnforcementError) {
    console.error(error.toJSON());
  } else {
    throw error;
  }
}
```

Active deny and retry-cap rules throw `TraiceEnforcementError` before the provider call. Shadow rules, unsupported actions, malformed rules, unavailable evidence, rule API errors, and explicit bypasses pass through. Streaming requests can be denied or retry-capped but are never cached.

Swap and downgrade require current experiment evidence for the exact feature, source model, and target model. Fallback makes one configured fallback call after the original provider call fails. If it also fails, the original provider error is preserved.

## Privacy and failure behavior

Provider errors are re-thrown. Adapter failures do not replace a successful provider response unless your application explicitly waits for adapter writes. Use `onError` or `verbose` configuration for adapter diagnostics.

Prompts and outputs are not required for attribution. Only pass `prompt` or `output` when your organization has explicitly approved sample capture.

## Reference and source

- [TypeScript API reference](/docs/typescript-reference)
- [Package on npm](https://www.npmjs.com/package/@traice/sdk)
- [SDK source](https://github.com/runtraice/traice-sdk/tree/main/packages/sdk)
- [SDK README](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/README.md)
