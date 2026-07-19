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

The CLI is bundled with `@traice/sdk`; no separate global package is required.

```sh
npx @traice/sdk --version
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

## Active request enforcement

`CloudAdapter.enforceRequest()` executes active exact-cache, deny, and retry-cap
rules. Keep one adapter per process and pass the effective request to the
provider callback:

```ts
import { CloudAdapter, TraiceEnforcementError } from "@traice/sdk";

const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
const request = { model: "gpt-4o-mini", messages, temperature: 0 };

try {
  const response = await cloud.enforceRequest(
    request,
    (effectiveRequest) => openai.chat.completions.create(effectiveRequest),
    { feature: "support", retryCount: 0, provider: "openai" },
  );
} catch (error) {
  if (error instanceof TraiceEnforcementError) {
    return { status: 429, body: error.toJSON() };
  }
  throw error;
}

console.log(cloud.getExactCacheStats());
```

An active `DENY` rule blocks a matching call. An active `CAP_RETRIES` rule
blocks only when `retryCount` is greater than its configured `maxRetries`.
Both return a structured `TraiceEnforcementError` and do not call the provider.
Shadow rules, unsupported actions, malformed rules, and rule API failures pass
through unchanged. Decision telemetry is best-effort and never includes the
request or response payload.

For exact caching, the request hash includes the complete normalized request
and is scoped to the workspace API key and rule. Use `{ bypass: true }` for all
request enforcement, or the `x-traice-cache-bypass: 1` header for a cache-only
bypass. Streaming requests are never cached. The existing
`enforceExactCache()` method remains available for cache-only integrations.

## Enforcement decision core

`decide(request, rules, context)` is the pure, synchronous rule planner used by
the exact-cache wrapper. It evaluates rule state, priority, request conditions,
model allowlists, and optional equivalence evidence without network or file I/O.
It returns either `PASS_THROUGH` or an active/shadow decision with a structured
reason. The SDK exports its request, rule, context, and decision types for
custom wrappers and deterministic tests.

This API plans a decision; it does not itself call a model provider.
`CloudAdapter.enforceRequest()` executes exact-cache, deny, and retry-cap
decisions. Swap, downgrade, fallback, semantic-cache, and route execution remain
disabled until their safety contracts are released.

## Privacy

Prompts and outputs are not required for cost attribution. Only pass `prompt` or `output` when your workspace has explicitly opted into sample capture.
