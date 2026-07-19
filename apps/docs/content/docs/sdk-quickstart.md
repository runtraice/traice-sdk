---
title: SDK Quickstart
excerpt: Install @traice/sdk and send product-runtime LLM cost events.
order: 2
---

# SDK Quickstart

Install the SDK:

```sh
npm install @traice/sdk
```

TypeScript:

```ts
import { configure, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const completion = await meter(
  "support-summary",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    userId: "user_123",
    tenantId: "acme",
    workflowId: "support",
  },
);
```

JavaScript:

```js
const { configure, meter } = require("@traice/sdk");

configure({
  adapters: ["local"],
  localPath: "./.traice-costs/events.ndjson",
});
```

The package ships TypeScript declarations plus ESM and CommonJS builds.

## Exact-cache guardrails

To opt a request path into an active exact-cache rule, keep one `CloudAdapter`
instance for the process and wrap the provider call:

```ts
import { CloudAdapter } from "@traice/sdk";

const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
const request = { model: "gpt-4o-mini", messages, temperature: 0 };

const response = await cloud.enforceExactCache(request, () => openai.chat.completions.create(request), {
  feature: "support",
  provider: "openai",
});
```

Only an active `CACHE_EXACT` rule can change the call. Cache misses, rule/API
errors, explicit bypasses, and all streaming requests call the provider normally.
Use `cloud.getExactCacheStats()` for process-local hits, misses, bypasses, hit
rate, and realized savings. trAIce receives hit/miss outcomes and token cost
bases, but not the cached request or response payload.

## Plan enforcement decisions

The SDK exports a pure `decide(request, rules, context)` function for custom
wrappers and deterministic rule tests. It evaluates state, priority,
conditions, model allowlists, and supplied equivalence evidence without I/O,
then returns `PASS_THROUGH` or a structured active/shadow decision.

Planning does not call a model provider. `CloudAdapter.enforceExactCache()` is
currently the only built-in executor. Swap, downgrade, deny, retry-cap,
fallback, and route execution remain disabled until their guarded executors are
released.
