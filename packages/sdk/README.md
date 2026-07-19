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

## OpenTelemetry and vendor imports

Point an OTLP HTTP/JSON exporter at `https://www.runtraice.com/api/v1/otel/v1/traces` to ingest GenAI spans. Existing LiteLLM and Langfuse data can be previewed and backfilled through the same CLI credential:

```sh
export LITELLM_BASE_URL='https://litellm.example.com'
export LITELLM_MASTER_KEY='<spend-reader-key>'
traice import litellm --since 7d --dry-run
traice import litellm --since 30d
```

Langfuse uses `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` with `traice import langfuse`. Importers request usage/cost fields, not prompts or responses, and stable vendor IDs make repeated backfills idempotent. See the [integration guide](../../apps/docs/content/docs/integrations.md).

Export a versioned snapshot of user-authored rules, experiment evidence, and budget utilization for a gateway adapter or custom wrapper:

```sh
traice policy export --output traice-policy.json
```

The portable bundle contains no credentials and is not a lossy conversion to vendor-specific gateway configuration.

## Adapters

- `console`: print cost events locally.
- `local`: write newline-delimited JSON to disk.
- `cloud`: send product runtime events to trAIce.
- `webhook`: send events to an HTTP endpoint.
- `otel`: emit OpenTelemetry metrics.

## Advisory workspace budgets

Before opting into active rules, applications can consume workspace budget
policy as synchronous advice. Warm the cache at startup, then decide how your
own code responds:

```ts
const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
await cloud.warmPolicy();

const budget = cloud.getBudgetAdvice({ feature: "support", userId });
if (budget.isBlocked) return fallbackWithoutAnLlm();

const model = budget.shouldDowngrade ? "gpt-4o-mini" : "gpt-4o";
const response = await openai.chat.completions.create({ model, messages });
```

`shouldDowngrade()` becomes true at 80% utilization and `isBlocked()` at
100%, based on matching workspace, feature, and user budgets. The methods read
only a TTL-bound memory cache. A cold, expired, or failed policy refresh returns
false for both helpers and refreshes in the background, so policy never adds
request latency or blocks traffic by accident. `getBudgetAdvice()` includes the
matched scopes and reason; `getEnforcementStats()` exposes policy refresh and
fail-open counters.

## Active request enforcement

`CloudAdapter.enforceRequest()` executes the wrapper actions: exact and semantic
cache, deny, retry cap, evidence-gated swap, downgrade, or route, and one-shot
fallback. Keep one adapter per process and pass the effective request to the
provider callback:

```ts
import { CloudAdapter, TraiceEnforcementError } from "@traice/sdk";

const cloud = new CloudAdapter({ apiKey: process.env.TRAICE_API_KEY! });
await cloud.warmEnforcement();
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

Swap and downgrade rules execute only when the cached rules response includes a
current experiment for the exact feature, source model, and target model. The
experiment must meet the required equivalence and maximum quality-drop limits. The SDK passes
the rewritten request to the callback and reports the experiment and verifiable
token cost basis in the Decision Record.

Route rules have the same evidence contract and additionally require a non-empty
model allowlist containing the one configured target. The SDK never chooses a
model autonomously and is not a provider gateway.

Experiment-derived rules also carry an explicit `sourceModel` guard. The SDK
passes through when the live request model differs from the model that was
validated, even if another experiment exists for the same feature and target.

A fallback rule calls the original model first. After a provider error it makes
one call with the configured fallback model. If that call also fails, the SDK
rethrows the original provider error and does not add another retry.

Call `warmEnforcement()` during application startup. Request-path evaluation
reads only the in-memory rules and evidence cache. A cold or expired cache
passes the request through immediately and refreshes in the background.

Run the enforcement smoke harness against the workspace saved by the collector.
It uses a simulated provider, so it does not incur model spend:

```sh
npm run test:enforcement --workspace @traice/sdk
```

Set `TRAICE_API_KEY` and optionally `TRAICE_API_URL` to use a different
workspace. Set `OPENAI_API_KEY` to make a small real call. Use `TRAICE_MODEL`,
`TRAICE_FEATURE`, and `TRAICE_RETRY_COUNT` to match a rule. Set
`TRAICE_FAIL_MODEL` to simulate a primary error and test fallback.

For exact caching, the request hash includes the complete normalized request
and is scoped to the workspace API key and rule. Use `{ bypass: true }` for all
request enforcement, or the `x-traice-cache-bypass: 1` header for a cache-only
bypass. Streaming requests are never cached. The existing
`enforceExactCache()` method remains available for cache-only integrations.

Semantic caching is opt-in and process-local. Supply an embedding function that
uses infrastructure and credentials controlled by your application:

```ts
const cloud = new CloudAdapter({
  apiKey: process.env.TRAICE_API_KEY!,
  semanticCache: {
    embed: async (text) => myEmbeddingClient.embed(text),
    timeoutMs: 1_000,
    maxEntries: 250,
  },
});
```

The SDK sends no request text or response content to trAIce. By default the
embedder receives the normalized request; set `semanticCacheText` in the
enforcement context to supply a smaller approved representation. Entries are
scoped to the workspace, rule, and requested model, bounded by an LRU limit,
and governed by the rule TTL and similarity threshold. Streaming, explicit
bypass, missing configuration, invalid input, embedding errors, and embedding
timeouts call the provider normally. `getSemanticCacheStats()` exposes local
hits, misses, bypasses, failures, size, hit rate, and estimated savings.

## Enforcement decision core

`decide(request, rules, context)` is the pure, synchronous rule planner used by
the exact-cache wrapper. It evaluates rule state, priority, request conditions,
model allowlists, and optional equivalence evidence without network or file I/O.
It returns either `PASS_THROUGH` or an active/shadow decision with a structured
reason. The SDK exports its request, rule, context, and decision types for
custom wrappers and deterministic tests.

This API plans a decision; it does not itself call a model provider.
`CloudAdapter.enforceRequest()` executes exact-cache, semantic-cache, deny,
retry-cap, swap, downgrade, route, and fallback decisions under the contracts
described above.

## Privacy

Prompts and outputs are not required for cost attribution. Only pass `prompt` or `output` when your workspace has explicitly opted into sample capture.
