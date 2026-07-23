---
title: TypeScript API Reference
excerpt: Public @traice/sdk functions, classes, adapters, integrations, analytics, guardrails, and types.
section: Reference
sectionOrder: 5
order: 2
---

# TypeScript API Reference

Import every API on this page from `@traice/sdk`. The package ships ES module, CommonJS, and TypeScript declaration outputs for Node.js 20.9 or newer.

```typescript
import { configure, flush, meter } from "@traice/sdk";
```

The package entrypoint is [`packages/sdk/src/index.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts). The published declaration file is also available from the installed package as `dist/index.d.ts`.

## Global configuration and metering

| API             | Signature                                                              | Behavior                                                                                   | Source                                                                                  |
| --------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `configure`     | `(config: Partial<GlobalConfig>) => void`                              | Merge process-wide SDK configuration and rebuild adapters on the next use                  | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `getConfig`     | `() => GlobalConfig`                                                   | Return a shallow copy of the current global configuration                                  | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `resetConfig`   | `() => void`                                                           | Restore default global configuration                                                       | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `meter`         | `<T>(fn, options?) => Promise<T>`                                      | Run one provider call, return its response, and emit a cost event                          | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `meterStream`   | `<T extends AsyncIterable>(fn, options?) => Promise<T>`                | Return a provider stream and record usage after it completes                               | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `flush`         | `() => Promise<void>`                                                  | Wait for pending adapter writes and adapter buffers                                        | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `getMeterStats` | `() => { eventsTracked, eventsDropped, adapterErrors, unknownModels }` | Read process-local metering health counters                                                | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `resetStats`    | `() => void`                                                           | Reset process-local metering counters                                                      | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `CostMeter`     | `new CostMeter(config?)`                                               | Create an instance-scoped meter with `track`, `trackStream`, `record`, and `flush` methods | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |

`meter()` and `CostMeter.track()` rethrow provider errors and record an error event when possible. Adapter writes are fire-and-forget unless `MeterOptions.awaitWrites` is true.

`MeterOptions.provider` and `CostMeterConfig.provider` accept explicit string identifiers such as `google-vertex`. Explicit identifiers override response-shape detection and are honored by stream metering. CamelCase AI SDK token usage is read from `usage` or `totalUsage`.

## Cache and budget APIs

| API               | Signature                                                | Behavior                                                                              | Source                                                                                  |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `cachedMeter`     | `<T>(fn, options & { ttlMs?, cacheKey? }) => Promise<T>` | Cache a provider response in the process-local LRU cache and record zero cost on hits | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `getCacheStats`   | `() => CacheStats`                                       | Return hit, miss, size, hit-rate, and savings statistics                              | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `resetCache`      | `() => void`                                             | Clear the global process-local response cache                                         | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `globalCache`     | `LRUCache<any>`                                          | Export the global cache used by `cachedMeter`                                         | [cache.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/cache.ts) |
| `LRUCache`        | `new LRUCache<T>(maxSize?)`                              | Create a bounded TTL cache with savings metrics                                       | [cache.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/cache.ts) |
| `configureBudget` | `(config: BudgetConfig) => void`                         | Configure process-local daily feature budget callbacks                                | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `getBudgetStatus` | `() => BudgetStatus[]`                                   | Read current process-local budget accumulators                                        | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |
| `resetBudget`     | `() => void`                                             | Clear process-local budget rules and accumulators                                     | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/index.ts) |

These helpers are process-local. For cached workspace-wide budget advice, use
the `CloudAdapter` policy methods below.

## Pricing APIs

| API                    | Signature                                                                           | Behavior                                                          | Source                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `calculateCost`        | `(provider, model, inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?)` | Calculate input, output, and total cost in USD from local pricing | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `normalizeCacheTokens` | `(inputTokens, cacheReadTokens?, cacheWriteTokens?)`                                | Bound cache token subsets to the supplied input-token total       | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `configurePricing`     | `(provider, model, { input, output }) => void`                                      | Add or replace pricing for one model                              | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `setPricingTable`      | `(provider, table) => void`                                                         | Replace one provider pricing table                                | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `removePricing`        | `(provider, model) => boolean`                                                      | Remove one model and report whether it existed                    | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `getAvailableModels`   | `(provider) => string[]`                                                            | List models with local pricing for a provider                     | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |
| `getAllPricing`        | `() => Record<string, PricingTable>`                                                | Return a deep copy of all current pricing tables                  | [pricing/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/pricing/index.ts) |

## Adapters

Every adapter implements `CostAdapter` with an asynchronous `write(event)` method and an optional `flush()` method.

| Class or factory | Constructor                       | Behavior                                                       | Source                                                                                                    |
| ---------------- | --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ConsoleAdapter` | `new ConsoleAdapter()`            | Print formatted events                                         | [console.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/console.ts)      |
| `LocalAdapter`   | `new LocalAdapter(filePath)`      | Append newline-delimited JSON and serialize writes             | [local.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/local.ts)          |
| `CloudAdapter`   | `new CloudAdapter(config)`        | Batch cloud events and execute supported active request rules  | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)          |
| `WebhookAdapter` | `new WebhookAdapter(config)`      | Batch and POST full local cost events to a custom endpoint     | [webhook.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/webhook.ts)      |
| `OTelAdapter`    | `new OTelAdapter(config?)`        | Record cost, token, and duration metrics through OpenTelemetry | [otel.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/otel.ts)            |
| `createAdapter`  | `(name, options?) => CostAdapter` | Resolve a built-in adapter by name                             | [adapters/index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/index.ts) |

### `CloudAdapter` request methods

| Method                                               | Behavior                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `write(event)`                                       | Buffer a local `CostEvent` for cloud delivery                                        |
| `flush()`                                            | Send buffered events and wait for pending decision telemetry                         |
| `warmEnforcement()`                                  | Fetch and cache current rules and experiment evidence before serving traffic         |
| `warmPolicy()`                                       | Fetch and cache workspace, feature, and user budget status                           |
| `getBudgetAdvice(context?)`                          | Return cached matches, utilization, reason, and advisory downgrade/block booleans    |
| `shouldDowngrade(context?)`                          | Return cached advice at the 80% warning threshold; cold/error policy returns false   |
| `isBlocked(context?)`                                | Return cached advice at the 100% exceeded threshold; cold/error policy returns false |
| `enforceRequest(request, providerCall, context?)`    | Execute supported active rules for one opted-in request path                         |
| `enforceExactCache(request, providerCall, context?)` | Execute only an active exact-cache rule and otherwise pass through                   |
| `getExactCacheStats()`                               | Return process-local exact-cache hits, misses, bypasses, size, hit rate, and savings |
| `getSemanticCacheStats()`                            | Return process-local semantic-cache health, hit rate, and estimated savings          |
| `getDeliveryStats()`                                 | Return queue, acknowledgement, retry, failure, and delivery timestamp counters       |

`CloudAdapterConfig` supports a bounded memory queue, request timeout, retry
attempt and delay caps, delivery observers, privacy-safe content capture, and
an optional `durableQueuePath`. Global configuration exposes
`cloudMaxQueueSize`, `cloudCaptureContent`, and `cloudDurableQueuePath`.

## Request enforcement

| API                           | Purpose                                                                                           | Source                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `decide`                      | Pure synchronous rule planner with no network or file I/O                                         | [enforcement.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/enforcement.ts) |
| `TraiceEnforcementError`      | Structured refusal for active `DENY` and `CAP_RETRIES` decisions                                  | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)    |
| `CloudAdapter.enforceRequest` | Executor for exact or semantic cache, deny, retry cap, evidence-gated model actions, and fallback | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)    |

`TraiceEnforcementError` exposes `code`, `action`, `ruleId`, `ruleName`, `requestedModel`, `reason`, and `toJSON()`. Route requires a non-empty allowlist and passing experiment evidence. Semantic cache requires an opt-in customer-supplied embedder and remains process-local.

## Framework integrations

| API                       | Signature                                | Source                                                                                                                    |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `createExpressMiddleware` | `(config) => (req, res, next) => void`   | [middleware/express.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/middleware/express.ts)         |
| `withCostTracking`        | `(config, routeHandler) => routeHandler` | [integrations/nextjs.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/integrations/nextjs.ts)       |
| `withMeteredAction`       | `(config, serverAction) => serverAction` | [integrations/nextjs.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/integrations/nextjs.ts)       |
| `createNextApiHandler`    | `(config, pagesHandler) => pagesHandler` | [integrations/nextjs.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/integrations/nextjs.ts)       |
| `LangChainCostHandler`    | `new LangChainCostHandler(config?)`      | [integrations/langchain.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/integrations/langchain.ts) |

## Analytics and read APIs

| API                         | Signature                                                                   | Source                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `forecast`                  | `(events: CostEvent[]) => ForecastResult[]`                                 | [analytics/forecast.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/analytics/forecast.ts)       |
| `detectAnomalies`           | `(events, options?) => AnomalyResult[]`                                     | [analytics/anomalies.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/analytics/anomalies.ts)     |
| `comparePromptVersions`     | `(events, promptName?) => VersionComparison[]`                              | [analytics/compare.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/analytics/compare.ts)         |
| `optimizeModels`            | `(events) => ModelRecommendation[]`                                         | [analytics/optimizer.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/analytics/optimizer.ts)     |
| `detectTokenAbuse`          | `(events, options?) => TokenAbuseResult[]`                                  | [analytics/token-abuse.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/analytics/token-abuse.ts) |
| `askTraice`                 | `(question, { apiKey, serverUrl?, signal? }) => Promise<AskTraiceResponse>` | [ask.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/ask.ts)                                     |
| `normalizeServerUrl`        | `(value) => string`                                                         | [ask.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/ask.ts)                                     |
| `DEFAULT_TRAICE_SERVER_URL` | `"https://www.runtraice.com"`                                               | [ask.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/ask.ts)                                     |

## Vendor import APIs

| API                      | Signature                                                         | Behavior                                                                 | Source                                                                                                    |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `importLiteLlm`          | `(options: LiteLlmImportOptions) => Promise<VendorImportResult>`  | Import bounded LiteLLM spend-log windows with retry-safe identities      | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts) |
| `importLangfuse`         | `(options: LangfuseImportOptions) => Promise<VendorImportResult>` | Import bounded Langfuse generation observations without prompt or output | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts) |
| `mapLiteLlmSpendLog`     | `(value: unknown) => ImportedEvent \| null`                       | Normalize one LiteLLM spend log                                          | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts) |
| `mapLangfuseObservation` | `(value: unknown) => ImportedEvent \| null`                       | Normalize one Langfuse observation                                       | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts) |
| `parseImportRange`       | `(since, until?, now?) => ImportRange`                            | Parse an ISO boundary or duration such as `7d`                           | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts) |

## Portable policy API

| API            | Signature                                                         | Behavior                                                                       | Source                                                                                    |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `exportPolicy` | `(options: ExportPolicyOptions) => Promise<PortablePolicyBundle>` | Fetch and validate user-authored rules, evidence, and budget snapshots as JSON | [policy.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/policy.ts) |

## Exported types

| Group                   | Public types                                                                                                                                               | Source                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Events and metering     | `EventMetadata`, `CostEvent`, `MeterOptions`, `CostMeterConfig`, `CostAdapter`, `GlobalConfig`, `ErrorHandler`, `MeterStats`                               | [types.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/types.ts)                                                                                                   |
| Pricing and reports     | `ModelPricing`, `PricingTable`, `SummaryRow`, `ReportOptions`                                                                                              | [types.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/types.ts)                                                                                                   |
| Middleware and adapters | `ExpressMiddlewareOptions`, `WebhookAdapterConfig`, `OTelAdapterConfig`, `CloudAdapterConfig`, `SemanticCacheConfig`                                       | [types.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/types.ts), [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts) |
| Budgets and cache       | `BudgetRule`, `BudgetConfig`, `BudgetStatus`, `CacheStats`                                                                                                 | [types.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/types.ts), [cache.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/cache.ts)          |
| Request cache           | `ExactCacheContext`, `ExactCacheRequest`, `ExactCacheStats`, `SemanticCacheStats`                                                                          | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)                                                                                          |
| Request enforcement     | `BlockingRuleAction`, `ModelRuleAction`, `RequestEnforcementContext`, `EnforcementEvidence`                                                                | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)                                                                                          |
| Rule planning           | `EnforcementBudgetScope`, `EnforcementContext`, `EnforcementDecision`, `EnforcementRequest`, `EnforcementRule`, `RuleAction`, `RuleCondition`, `RuleState` | [enforcement.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/enforcement.ts)                                                                                       |
| Analytics               | `ForecastResult`, `AnomalyResult`, `AnomalyOptions`, `VersionComparison`, `ModelRecommendation`, `TokenAbuseOptions`, `TokenAbuseResult`                   | [analytics](https://github.com/runtraice/traice-sdk/tree/main/packages/sdk/src/analytics)                                                                                                 |
| Ask trAIce              | `AskTraiceResponse`                                                                                                                                        | [ask.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/ask.ts)                                                                                                       |
| Vendor imports          | `ImportCredential`, `ImportRange`, `ImportedEvent`, `LiteLlmImportOptions`, `LangfuseImportOptions`, `VendorImportResult`                                  | [vendor-imports.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/vendor-imports.ts)                                                                                 |
| Portable policy         | `ExportPolicyOptions`, `PortablePolicyBundle`, `PortablePolicyBudget`, `PortablePolicyEvidence`                                                            | [policy.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/policy.ts)                                                                                                 |

## Related guides

- [TypeScript and Node.js SDK](/docs/typescript-sdk)
- [Event contract reference](/docs/event-reference)
- [`@traice/sdk` package source](https://github.com/runtraice/traice-sdk/tree/main/packages/sdk)
