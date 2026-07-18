---
title: Install Guide
excerpt: Sign in, create an API key, install the SDK or collector, and send your first trAIce event.
order: 2
---

# Install Guide

This is the canonical setup guide for trAIce. Use it for a fresh workspace, a new service, or an internal AI-tool collector rollout.

## Before You Start

You need:

- A trAIce account and workspace.
- A trAIce API key from the app.
- A TypeScript or JavaScript project for product-runtime events, or any runtime that can send an HTTP POST.
- Provider keys for OpenAI, Anthropic, Bedrock, or your LLM vendor. Those stay in your infrastructure.

## 1. Sign In

Sign in at [runtraice.com](https://runtraice.com/login). A workspace is created automatically the first time you sign in.

## 2. Create An API Key

Open [API keys](https://runtraice.com/app/api-keys), create a key, and store it in your secret manager or `.env` file.

```sh
TRAICE_API_KEY=trc_...
```

The full key is shown once.

## 3. Send Product LLM Events

Install the SDK:

```sh
npm install @traice/sdk
```

TypeScript:

```ts
import { configure, meter } from "@traice/sdk";
import OpenAI from "openai";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const openai = new OpenAI();

await meter(
  "support-summary",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    tenantId: "customer_42",
    userId: "user_123",
    workflowId: "support",
  },
);
```

JavaScript:

```js
const { configure, meter } = require("@traice/sdk");
```

`tenantId` is the key field for customer margin. Pass the customer or account id you bill on every product event.

## 4. Send Events Over HTTP

If you are not ready to use the SDK, send a product event directly:

```sh
curl -X POST "https://runtraice.com/api/v1/events" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "provider": "openai",
    "model": "gpt-4o-mini",
    "feature": "chat",
    "tenantId": "customer_42",
    "promptTokens": 1200,
    "outputTokens": 50,
    "cacheReadTokens": 800,
    "cacheWriteTokens": 0,
    "costUsd": 0.0012
  }'
```

## 5. Track Internal AI-Tool Spend

Internal Spend is separate from product events. The maintained collector supports Claude Code and Codex today. Send
other employee or team usage through the authenticated internal-usage API until native connectors are available.

Install the local collector for Claude Code:

```sh
printf "trAIce API key: "
stty -echo
IFS= read -r TRAICE_API_KEY
stty echo
printf "\n"
printf "%s" "$TRAICE_API_KEY" | npx @traice/collector@latest install claude-code \
  --api-key-stdin \
  --server-url https://runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering \
  --seat-monthly-usd 200 \
  --patch-settings
unset TRAICE_API_KEY
```

Start the collector:

```sh
npx @traice/collector@latest collect --agent claude-code
```

Send an internal usage row directly:

```sh
curl -X POST "https://runtraice.com/api/v1/internal-usage" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "sourceKey": "claude-code-local",
    "sourceName": "Claude Code local collector",
    "sourceKind": "claude_code_otel",
    "tool": "claude-code",
    "category": "coding_agent",
    "employeeEmail": "you@company.com",
    "employeeName": "Your Name",
    "teamName": "Engineering",
    "provider": "openai",
    "model": "gpt-5.5",
    "inputTokens": 42000,
    "cachedInputTokens": 38000,
    "outputTokens": 800,
    "costBasis": "usage_only"
  }'
```

Product events answer which customer or feature spent money. Internal Spend answers which employee, team, and AI tool spent money. Keep those identifiers separate.

## 6. Check The Dashboard

After the first product event lands, open [the dashboard](https://runtraice.com/app/dashboard). For customer margin, add revenue rows under Settings -> Customer revenue.

For Internal Spend, open Dashboard -> Internal Spend after collector events arrive.

## Next Steps

- [SDK Quickstart](sdk-quickstart)
- [Collector Overview](collector-overview)
- [Claude Code](claude-code)
- [Codex](codex)
