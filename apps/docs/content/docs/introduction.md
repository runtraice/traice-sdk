---
title: Introduction
excerpt: Public packages for product LLM attribution and coding-agent spend collection.
section: Getting started
sectionOrder: 1
order: 1
---

# Introduction

trAIce connects AI usage to the business dimensions that explain it: customer, user, feature, workflow, agent, and team. The public repository provides product-runtime SDKs, a direct HTTP contract, and local coding-agent collectors.

## Choose a data path

Product usage and internal AI-tool usage are separate data streams. Choose the path that matches who initiated the spend.

| Path                     | Use it for                                                    | Destination              | Start here                                     |
| ------------------------ | ------------------------------------------------------------- | ------------------------ | ---------------------------------------------- |
| Product SDKs             | LLM calls made by your application for customers or end users | `/api/v1/events`         | [Product SDKs](/docs/sdk-quickstart)           |
| Internal Spend collector | Claude Code and Codex usage by employees and teams            | `/api/v1/internal-usage` | [Collector overview](/docs/collector-overview) |
| Ask trAIce               | Read-only spend, margin, waste, budget, and alert questions   | `/api/v1/ask` or MCP     | [Ask trAIce](/docs/ask-traice)                 |

Do not send employee coding-agent usage as a product event. Do not use customer identifiers as employee identifiers. Keeping the two paths separate preserves clear allocation and reporting.

## Public packages

| Package             | Purpose                                                                                      | Registry                                               | Source                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `@traice/sdk`       | TypeScript and Node.js product-runtime metering, adapters, analytics, and request guardrails | [npm](https://www.npmjs.com/package/@traice/sdk)       | [packages/sdk](https://github.com/runtraice/traice-sdk/tree/main/packages/sdk)             |
| `traice-sdk`        | Python product-runtime collection for OpenAI, Anthropic, LangChain, and LangGraph            | [PyPI](https://pypi.org/project/traice-sdk/)           | [packages/python](https://github.com/runtraice/traice-sdk/tree/main/packages/python)       |
| `@traice/collector` | Local Claude Code and Codex telemetry collection                                             | [npm](https://www.npmjs.com/package/@traice/collector) | [packages/collector](https://github.com/runtraice/traice-sdk/tree/main/packages/collector) |
| `@traice/protocol`  | Shared public event types, validation, normalization, and redaction helpers                  | [npm](https://www.npmjs.com/package/@traice/protocol)  | [packages/protocol](https://github.com/runtraice/traice-sdk/tree/main/packages/protocol)   |

## Product attribution model

Every product integration can attach the same dimensions:

- `tenantId` identifies the customer or account that pays you.
- `userId` identifies the end user who initiated the call.
- `feature` identifies the product capability or request path.
- `workflowId`, `runId`, and `stepId` identify multi-step executions.
- `agentId` and `toolName` identify agent and tool activity.
- `outcome` and `retryCount` explain result quality and retry behavior.
- `metadata` carries additional structured context that is safe to send.

`tenantId` is the primary dimension for customer-level AI contribution margin. Use the same stable customer identifier that your billing or revenue data uses.

## Security and privacy

Store the trAIce API key in your secret manager and provide it through `TRAICE_API_KEY`. Provider keys remain in your infrastructure and are never sent to trAIce.

Product attribution does not require prompts or model outputs. The Python SDK never sends either. The TypeScript SDK sends them only when you explicitly pass `prompt` or `output` and your workspace is configured to accept samples. Collectors keep prompt capture off by default.

## Next steps

1. [Create a workspace key and send a first event](/docs/install).
2. Choose [TypeScript and Node.js](/docs/typescript-sdk), [Python](/docs/python-sdk), or [HTTP and cURL](/docs/http-api).
3. Use the [API reference](/docs/api-reference) for signatures, event contracts, and source links.
