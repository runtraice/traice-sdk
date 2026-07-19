---
title: HTTP and cURL
excerpt: Send attributed product usage events from any runtime through the public HTTP contract.
section: Product SDKs
sectionOrder: 2
order: 4
---

# HTTP and cURL

Use the HTTP integration when an SDK is not available for your runtime or when an existing telemetry pipeline already extracts provider usage. Your application supplies token counts, cost, attribution, delivery, and retry behavior.

## Endpoint and authentication

Send product events to:

```text
POST https://www.runtraice.com/api/v1/events
```

Authenticate with a workspace API key in the `Authorization` header. Store the key in a secret manager and expose it to the sending process as `TRAICE_API_KEY`.

```curl
curl -X POST "https://www.runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "feature": "support-summary",
    "tenantId": "customer_42",
    "userId": "user_123",
    "workflowId": "support",
    "promptTokens": 1200,
    "outputTokens": 50,
    "cacheReadTokens": 800,
    "cacheWriteTokens": 0,
    "costUsd": 0.0012,
    "latencyMs": 842,
    "status": "success",
    "metadata": {
      "plan": "pro"
    }
  }'
```

## Batch events

The maintained SDKs send an `events` envelope. Use the same shape to reduce request overhead when your integration already buffers events.

```curl
curl -X POST "https://www.runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "events": [
      {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "feature": "chat",
        "tenantId": "customer_42",
        "promptTokens": 300,
        "outputTokens": 40,
        "costUsd": 0.000069
      },
      {
        "provider": "anthropic",
        "model": "claude-sonnet-4-20250514",
        "feature": "draft-reply",
        "tenantId": "customer_42",
        "promptTokens": 500,
        "outputTokens": 80,
        "costUsd": 0.0027
      }
    ]
  }'
```

## Product event fields

| Field              | Required | Meaning                                                               |
| ------------------ | -------- | --------------------------------------------------------------------- |
| `provider`         | Yes      | Provider identifier such as `openai`, `anthropic`, or `google-vertex` |
| `model`            | Yes      | Provider model identifier                                             |
| `promptTokens`     | Yes      | Total input tokens, including provider cache tokens when applicable   |
| `outputTokens`     | Yes      | Generated output tokens                                               |
| `costUsd`          | Yes      | Calculated event cost in USD                                          |
| `ts`               | No       | ISO 8601 event time; ingestion time is used when omitted              |
| `totalTokens`      | No       | Total tokens when already calculated                                  |
| `cacheReadTokens`  | No       | Input tokens served from a provider cache                             |
| `cacheWriteTokens` | No       | Input tokens written to a provider cache                              |
| `latencyMs`        | No       | Provider call latency in milliseconds                                 |
| `status`           | No       | `success` or `error`                                                  |
| `feature`          | No       | Product feature or request path                                       |
| `tenantId`         | No       | Paying customer or account                                            |
| `userId`           | No       | End user                                                              |
| `agentId`          | No       | Agent identity                                                        |
| `workflowId`       | No       | Workflow identity                                                     |
| `runId`            | No       | One workflow or agent execution                                       |
| `stepId`           | No       | Step within an execution                                              |
| `toolName`         | No       | Tool used by an agent                                                 |
| `retryCount`       | No       | Retry attempt number                                                  |
| `outcome`          | No       | Product or workflow result                                            |
| `metadata`         | No       | JSON object with additional safe context                              |

See the [event contract reference](/docs/event-reference) for the transport shape, SDK-local event shape, internal usage shape, and protocol utilities.

## Calculate cost

The HTTP API does not inspect a provider response for you. Extract usage after the provider call and calculate `costUsd` from the provider price that applies to the model and request date.

Count cached input tokens inside `promptTokens`, then also provide `cacheReadTokens` and `cacheWriteTokens` so trAIce can explain the cost basis. Use zero for an unknown cost while preserving token counts. Update the integration when pricing becomes known.

## Delivery and retries

Treat a non-success HTTP response as a delivery failure. Bound your buffer, request timeout, retry count, and shutdown flush so telemetry cannot block or exhaust the application.

Retry event delivery, not the provider call. A failed trAIce request must never cause the application to repeat an LLM request and incur duplicate provider spend.

## Privacy

Product attribution needs usage and business dimensions, not prompts or model outputs. Do not put secrets, provider keys, authorization headers, or sensitive content in `metadata`.

## Related pages

- [Product SDK comparison](/docs/sdk-quickstart)
- [Event contract reference](/docs/event-reference)
- [TypeScript and Node.js SDK](/docs/typescript-sdk)
- [Python SDK](/docs/python-sdk)
