# @traice/sdk

Runtime LLM cost attribution for TypeScript and JavaScript applications.

## Install

```sh
npm install @traice/sdk
```

## TypeScript

```ts
import { configure, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const completion = await meter(
  "ticket-summary",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    userId: "user_123",
    tenantId: "acme",
    env: process.env.NODE_ENV ?? "development",
  },
);
```

## JavaScript

```js
const { configure, meter } = require("@traice/sdk");

configure({
  adapters: ["local"],
  localPath: "./.traice-costs/events.ndjson",
});
```

ES modules work too:

```js
import { configure, meter } from "@traice/sdk";
```

## CLI

```sh
npx @traice/sdk report --file ./.traice-costs/events.ndjson
npx @traice/sdk forecast
npx @traice/sdk anomalies --threshold 2
```

## Adapters

- `console`: print cost events locally.
- `local`: write newline-delimited JSON to disk.
- `cloud`: send product runtime events to trAIce.
- `webhook`: send events to an HTTP endpoint.
- `otel`: emit OpenTelemetry metrics.

## Active exact-cache guardrails

An active `CACHE_EXACT` rule in trAIce can short-circuit identical non-streaming
requests through a bounded, process-local cache:

```ts
import { CloudAdapter } from "@traice/sdk";

const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
const request = { model: "gpt-4o-mini", messages, temperature: 0 };

const response = await cloud.enforceExactCache(request, () => openai.chat.completions.create(request), {
  feature: "support",
  provider: "openai",
});

console.log(cloud.getExactCacheStats());
```

The request hash includes the complete normalized request and is scoped to the
workspace API key and rule. Rule lookup, cache bookkeeping, and Decision Record
telemetry fail open. Use `{ bypass: true }` or the
`x-traice-cache-bypass: 1` header for a per-call bypass. Streaming requests are
always passed through because provider stream objects cannot be replayed safely.
Matched hits and misses are reported to trAIce so the Guardrails page can show
the real cache hit rate; payloads remain process-local.

## Privacy

Prompts and outputs are not required for cost attribution. Only pass `prompt` or `output` when your workspace has explicitly opted into sample capture.
