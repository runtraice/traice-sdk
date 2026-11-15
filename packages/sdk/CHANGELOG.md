# @traice/sdk Changelog

## 0.11.0

### Minor Changes

- 3862836: Support Amazon Bedrock. `meter()` recognizes a Converse response as provider `aws-bedrock` and counts cache reads and writes in the input. The new `CloudAdapter.enforceBedrockRequest()` runs a request that names its model as `modelId` through active rules, and rewrites `modelId` for swaps, rollouts, and fallbacks. Decisions now report the cost basis of the model that was served when a response does not name its model.
- 401f8be: Fallback rules can bound and retry the original call. A rule's `timeoutMs` gives each call a deadline, `retryOn` (`timeout`, `429`, `5xx`, or `error`) chooses which failures lead to a retry or the fallback, and `maxRetries` with `backoffMs` retries the original model with jittered exponential backoff before falling back. `enforceRequest` and `enforceBedrockRequest` pass `{ signal }` to the provider callback as an optional second argument so a call past its deadline can be aborted. Fallback decisions now report `errorType`, `fallbackLatencyMs`, and the number of attempts. Rules without these parameters behave as before.
- 2171a66: Send the full request for replay. `meter()`, `CostMeter.track()` and `record()` accept a `request` option with OpenAI Chat Completions, Anthropic Messages, or Bedrock Converse parameters. The new `captureRequest()` reduces it to the system prompt, the user and assistant turns, and the sampling parameters, and drops requests with tool calls, images, or other non-text parts. Cloud delivery sends it only when content capture is on.
- 4cb0de7: Load balancing across provider keys (enforcement protocol v5). `CloudAdapter` now polls rules with `X-Traice-Enforcement-Version: 5` and, when the response carries `loadBalance: { version: "load-balance-v1" }`, applies `LOAD_BALANCE` rules. A rule names your provider keys by alias, with weights. For each call a rule matches (on the request actually sent to the provider, after any swap, rollout, or fallback, and its feature), the SDK picks an alias by weight and passes it to the provider callback as `options.keyAlias`, which your callback maps to its own client or key; trAIce never sees keys. When the provider rate-limits a key (HTTP 429 or `ThrottlingException`), the SDK rests it for the provider's `Retry-After` (1 s to 600 s) or the rule's cooldown, and with `onRateLimit: "next_key"` retries the call on a key it has not tried, at most once per key; otherwise the provider error is thrown. Other errors and refusals by trAIce never switch keys. Each attempt goes through the strict cap check, while a rate-limit rule counts the call once. A rule in preview leaves the call unchanged and reports the key it would use. One decision per call reports the key it ended on, the attempts, the keys it left after a rate limit, and the outcome. If load balancing itself fails, the call goes to the provider as if no rule matched and `onEnforcementError` gets operation `load_balance`. `decide()` skips load-balancing rules. The SDK's internal rule matching and key choice follow trAIce, with conformance cases in `load-balance-v1.json`; they are not exported. `getLoadBalanceStats()` reports calls, switches, exhausted calls, and calls per key alias.
- 8593944: Rate limits (enforcement protocol v3). `CloudAdapter` now polls rules with `X-Traice-Enforcement-Version: 3` and receives `RATE_LIMIT` rules, which cap requests and/or tokens per minute for the whole workspace, each API key, or each end user (`userId` in the request context). Before a matching call, the SDK asks trAIce to count it, so a limit holds across every instance; it waits at most the advertised `timeoutMs` (150 ms) and lets the call through if trAIce does not answer. A refusal throws `TraiceEnforcementError` with action `RATE_LIMIT` and `retryAfterMs`, and the SDK refuses locally for that rule until the retry time passes. Calls matched by a tokens-per-minute rule report their tokens in the background. `decide()` skips rate-limit rules, so a limit never hides a later rule; the SDK matches them internally (not exported). `getRateLimitStats()` reports acquired, refused, locally refused, would-have-refused and fail-open counts.
- 60efb61: Share exact-cache answers across instances. When a workspace opts in to trAIce's shared response cache and an exact-cache rule is marked shared, `CloudAdapter` checks trAIce after a local miss and stores new answers in the background. The request never leaves the process: lookups send only an HMAC key (protocol `shared-exact-v1`, matching `@traice/enforce`). Lookups wait at most 150 ms and fail open; a refusal from trAIce turns the shared cache off until the next rules refresh. `getExactCacheStats()` adds `sharedHits`, `sharedLookupFailures` and `sharedStores`.
- e070fd6: Shared semantic cache client. With `semanticCache.embeddingModel` set and a workspace opted in to trAIce's shared semantic cache, `CloudAdapter` looks up semantic-cache rules marked shared on trAIce after a local miss, sending only the request's embedding, the rule, the requested model and the embedding model name, never the request text. Lookups wait at most the advertised `timeoutMs` (300 ms) and fail open; new answers are stored in the background. A 403 or 409 turns sharing off until the next rules refresh. `getSemanticCacheStats()` adds `sharedHits`, `sharedLookupFailures`, and `sharedStores`, and shared hits are reported with `cacheStore: "shared"`.
- 548071c: Strict budget caps (enforcement protocol v4). `CloudAdapter` now polls rules with `X-Traice-Enforcement-Version: 4` and receives `strictCaps`: the strictly capped budgets past 90% of their limit that apply to this API key. Before each call one of them applies to, right before the provider call and after rate limits, the SDK asks trAIce to check the call (`POST /api/v1/budget-caps/acquire`) with the model the call goes to, the provider, feature, user, a rough input token count, and the request's output token limit, never the request text. Cache hits make no check. A refusal throws `TraiceEnforcementError` with action `DENY`, the cap's rule, and `reason.strictCap: true`, without calling the provider, and is reported as a blocking decision. The SDK waits at most the advertised `timeoutMs` (300 ms); if trAIce does not answer, it lets the call through unless a matching active cap says `onUnavailable: "block"`. Caps in preview never block. An allowed call's reservation ids go back with the next event of the same model and feature (`capReservationIds`), so trAIce releases its estimate once the real cost is recorded. A strict cap refusal is never retried by a fallback rule or a rollout's source fallback. The SDK matches the caps internally (not exported), with conformance cases in `strict-cap-v1.json`, and `getStrictCapStats()` reports checked, refused, unavailable, blocked-while-unavailable, and preview counts.

## 0.10.0

### Minor Changes

- 916a9e3: Add deterministic percentage assignment for model-change rollouts. Report
  authoritative pre-call eligibility, correlated assignment and attempt outcomes,
  control, treatment, candidate failure, source fallback, latency, enforcement
  overhead, bucket, and policy revision telemetry. Advertise enforcement protocol
  v2 when fetching rules or exporting policy.

## 0.9.0

### Minor Changes

- ad97c2a: Add privacy-safe exact prompt fingerprints and customer-controlled semantic cache opportunity telemetry for shadow guardrails.

## 0.8.0

### Minor Changes

- 69bb5ea: Harden telemetry delivery with stable event identities, bounded retry and
  timeout behavior, delivery health counters, privacy-safe content defaults, and
  optional restart-safe SDK storage.

  Accept collector telemetry into a bounded durable outbox before responding to
  local agents, drain it asynchronously in strict batches, and expose queue
  health. Add internal-event latency to the public protocol.

## 0.7.1

### Patch Changes

- b3c148f: Retain explicitly requested model identifiers when failed or nonstandard responses do not report a model. Add current GPT-5.4 through GPT-5.6 pricing and model-specific cache rates.

## 0.7.0

### Minor Changes

- 5321e9a: Add opt-in process-local semantic-cache execution and evidence-gated, explicitly allowlisted route execution to the cloud enforcement wrapper.

## 0.6.0

### Minor Changes

- 820e437: Add a typed portable enforcement-policy export API and `traice policy export` command for custom wrappers and gateway adapters.

## 0.5.0

### Minor Changes

- 9009bfc: Add retry-safe LiteLLM spend-log and Langfuse observation import helpers plus `traice import` CLI commands with bounded backfills and dry runs.

## 0.4.5

### Patch Changes

- e919ad1: Add two-step confirmed Ask trAIce actions to the TypeScript client and CLI for budgets, alert snoozes, and evidence-gated shadow guardrails.

## 0.4.4

### Patch Changes

- e8cb483: Add fail-open workspace budget advice with cached downgrade and block helpers plus policy health telemetry.

## 0.4.3

### Patch Changes

- 959bcb3: Require experiment-derived model rules to match the exact validated source model before enforcement.

## 0.4.2

### Patch Changes

- 470beaf: Add workspace kill-switch support, cached budget conditions, user-scoped enforcement context, and observable fail-open control-plane metrics for request-path enforcement.

## 0.4.1

### Patch Changes

- 4f86186: Support explicit provider identifiers and normalized AI SDK token usage in `meter()`.

## 0.4.0

### Minor Changes

- c6f7dab: Add opt-in request-path execution for active exact-cache, deny, retry-cap, evidence-gated swap or downgrade, and one-shot fallback rules with structured blocking errors and fail-open rule evaluation.

## 0.3.1

### Patch Changes

- Verify npm release automation and linked Slack release notifications.

## 0.3.0

### Minor Changes

- 002a0d1: Add the `traice ask` command, cross-platform secure credential storage, the read-only ask API client, and MCP client setup documentation.
- 77dc155: Export the pure enforcement decision core and use it for active exact-cache rule selection.

## 0.2.5

### Patch Changes

- 584eb56: Document the bundled CLI version command and verify the reviewed npm OIDC release notification flow.

## 0.2.4

### Patch Changes

- f331b37: Report the installed collector version from package metadata and refresh SDK, CLI, dashboard, and documentation copy.

## 0.2.3

### Patch Changes

- 44a55f6: Report the package version from the SDK CLI instead of a stale hard-coded value.

## 0.2.2

### Patch Changes

- f086445: Clarify that the SDK package includes the command-line interface.

## 0.2.1

### Patch Changes

- b035890: Build package artifacts during packing and verify every publishable tarball in
  CI so fresh release runners include declared entry points and command binaries.

## 0.2.0

### Minor Changes

- b2ac4ed: Add active exact-cache guardrails, safe streaming bypass, OpenAI Responses API
  savings calculation, and process-local cache metrics.

## Unreleased

- Add opt-in active exact-cache guardrails with deterministic request hashing,
  bounded process-local storage, bypass controls, Decision Records, and local
  hit-rate/savings metrics.
- Pass streaming requests through safely and correctly price OpenAI Responses
  API cache savings.

## 0.1.0

- Initial scoped public release under `@traice/sdk`.
- Supports TypeScript declarations and JavaScript consumers through ESM and CommonJS exports.
- Includes console, local file, cloud, webhook, and OpenTelemetry adapters.
