---
title: Event Contract Reference
excerpt: Product transport fields, SDK-local cost events, internal usage events, and protocol utilities.
section: Reference
sectionOrder: 5
order: 4
---

# Event Contract Reference

The public repository contains three related event shapes. They serve different stages of the data path and should not be treated as interchangeable.

| Shape                             | Produced by                                                   | Purpose                                                               | Source                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product cloud event               | TypeScript cloud adapter, Python client, or HTTP integrations | Transport product usage to `/api/v1/events`                           | [cloud.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/adapters/cloud.ts)                                                                                      |
| `CostEvent` / `ProductUsageEvent` | TypeScript metering and protocol consumers                    | Represent detailed local product cost and usage                       | [types.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/sdk/src/types.ts), [protocol](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts) |
| `InternalUsageEvent`              | Coding-agent collectors and internal integrations             | Transport employee and team AI-tool usage to `/api/v1/internal-usage` | [protocol](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts)                                                                                          |

## Product cloud event

This is the HTTP transport shape used by the maintained product SDKs.

| Field              | Type                   | Meaning                                                               |
| ------------------ | ---------------------- | --------------------------------------------------------------------- |
| `ts`               | `string`               | ISO 8601 event time                                                   |
| `source`           | `string?`              | Stable integration type; must be paired with `externalId`             |
| `externalId`       | `string?`              | Stable source record ID; must be paired with `source`                 |
| `provider`         | `string`               | Provider identifier such as `openai`, `anthropic`, or `google-vertex` |
| `model`            | `string`               | Provider model identifier                                             |
| `promptTokens`     | `number`               | Total input tokens                                                    |
| `outputTokens`     | `number`               | Generated output tokens                                               |
| `totalTokens`      | `number`               | Combined input and output token count                                 |
| `cacheReadTokens`  | `number?`              | Input tokens served from provider cache                               |
| `cacheWriteTokens` | `number?`              | Input tokens written to provider cache                                |
| `costUsd`          | `number`               | Event cost in USD                                                     |
| `latencyMs`        | `number?`              | Provider latency in milliseconds                                      |
| `status`           | `"success" \| "error"` | Provider-call outcome                                                 |
| `feature`          | `string?`              | Product feature or request path                                       |
| `tenantId`         | `string?`              | Paying customer or account                                            |
| `userId`           | `string?`              | End user                                                              |
| `agentId`          | `string?`              | Agent identity                                                        |
| `workflowId`       | `string?`              | Workflow identity                                                     |
| `runId`            | `string?`              | One workflow or agent execution                                       |
| `stepId`           | `string?`              | Step within an execution                                              |
| `toolName`         | `string?`              | Tool used by an agent                                                 |
| `retryCount`       | `number?`              | Retry attempt number                                                  |
| `outcome`          | `string?`              | Product or workflow result                                            |
| `metadata`         | `object`               | Structured context and SDK metadata                                   |
| `prompt`, `output` | `string?`              | Optional samples when explicitly supplied and approved                |

The TypeScript cloud adapter maps local error, cache, prompt-version, session, environment, and legacy tags into `metadata`. The Python client adds `metadata.sdk` and `metadata.sdkVersion`.

When both `source` and `externalId` are present, retries are idempotent within a workspace. A duplicate is reported as `deduplicated`, is not written again, does not update product rollups or alerts, and does not consume another ingest event. Use a stable source configuration namespace when two installations of the same integration can emit the same upstream identifier.

## Local `CostEvent`

`@traice/sdk` adapters receive the local `CostEvent` before cloud transport mapping.

| Field group          | Fields                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| Identity             | `id`, `timestamp`                                                                   |
| Provider             | `provider`, `model`                                                                 |
| Usage                | `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens`, `cacheWriteTokens` |
| Cost                 | `inputCostUSD`, `outputCostUSD`, `totalCostUSD`                                     |
| Request              | `latencyMs`, `status`, `errorMessage`, `cached`                                     |
| Product attribution  | `feature`, `tenantId`, `userId`, `sessionId`, `env`                                 |
| Workflow attribution | `agentId`, `workflowId`, `runId`, `stepId`, `toolName`, `retryCount`, `outcome`     |
| Prompt attribution   | `promptName`, `promptVersion`, optional `prompt`, optional `output`                 |
| Additional context   | `metadata`, legacy `tags`                                                           |

`@traice/protocol` exports a structurally similar `ProductUsageEvent` for consumers that need a shared public type without the SDK implementation.

## Internal usage event

Internal usage describes employee and team AI-tool spend. It is not a product event.

Required fields:

| Field           | Meaning                                                   |
| --------------- | --------------------------------------------------------- |
| `sourceKey`     | Stable source configuration identifier                    |
| `sourceKind`    | Source adapter or ingestion kind                          |
| `tool`          | Tool name, such as `claude-code` or `codex`               |
| `category`      | `coding_agent`, `chat_agent`, `ide_assistant`, or `other` |
| `sourceEventId` | Stable retry-safe source event identifier                 |
| `occurredAt`    | ISO 8601 event time                                       |

Optional identity and allocation fields:

| Field group     | Fields                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| Source          | `sourceName`, `sourcePrincipal`                                                     |
| Employee        | `employeeEmail`, `employeeName`, `employeeExternalId`                               |
| Team            | `teamName`, `teamExternalId`                                                        |
| Seat allocation | `seatMonthlyUsd`                                                                    |
| Provider        | `provider`, `model`                                                                 |
| Execution       | `runId`, `stepId`                                                                   |
| Usage           | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens` |
| Cost            | `costUsd`, `costBasis`                                                              |
| Result          | `status` with `success`, `error`, or `unknown`; optional `latencyMs`                |
| Context         | JSON-safe `metadata`                                                                |

## Protocol utilities

Import these from `@traice/protocol`.

| API                             | Behavior                                                                                                         | Source                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `normalizeInternalUsageEvent`   | Trim identifiers, normalize the timestamp and token counts, derive total tokens, and default status to `unknown` | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts) |
| `assertValidInternalUsageEvent` | Require core source fields and a valid timestamp                                                                 | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts) |
| `redactMetadata`                | Convert unknown values to JSON-safe values and redact secret-looking keys and credential patterns                | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts) |
| `stableSourceEventId`           | Join defined identifier parts with `:` for retry-safe source identity                                            | [index.ts](https://github.com/runtraice/traice-sdk/blob/main/packages/protocol/src/index.ts) |

Public protocol types also include `JsonPrimitive`, `JsonValue`, `JsonRecord`, `InternalUsageCategory`, `InternalUsageStatus`, `CollectorIdentity`, and `CollectorSource`.

## Related guides

- [HTTP and cURL](/docs/http-api)
- [TypeScript API reference](/docs/typescript-reference)
- [Python API reference](/docs/python-reference)
- [Collector overview](/docs/collector-overview)
