---
title: Install Guide
excerpt: Sign in, configure an SDK or collector, and send your first trAIce event.
section: Getting started
sectionOrder: 1
order: 2
---

# Install Guide

This is the canonical setup guide for trAIce. Use it for a fresh workspace, a new service, or an internal AI-tool collector rollout.

## Before You Start

You need:

- A trAIce account and workspace.
- A trAIce API key for product-runtime events. Interactive collectors use browser authorization instead.
- A TypeScript or Python project for product-runtime events, or any runtime that can send an HTTP POST.
- Provider keys for OpenAI, Anthropic, Bedrock, or your LLM vendor. Those stay in your infrastructure.

## 1. Sign In

Sign in at [runtraice.com](https://www.runtraice.com/login). A workspace is created automatically the first time you sign in.

## 2. Create An API Key

Open [API keys](https://www.runtraice.com/app/api-keys), create a key, and store it in your secret manager or `.env` file.

```sh
TRAICE_API_KEY=your_workspace_key
```

The full key is shown once.

## 3. Send Product LLM Events

:::language-snippet

```typescript install="npm install @traice/sdk openai"
import { configure, flush, meter } from "@traice/sdk";
import OpenAI from "openai";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const openai = new OpenAI();

await meter(
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
await flush();
```

```python install="pip install traice-sdk openai"
import os

from openai import OpenAI
from traice import configure, flush, track

configure(api_key=os.environ["TRAICE_API_KEY"])
openai = OpenAI()

@track(
    feature="support-summary",
    tenant_id="customer_42",
    user_id="user_123",
    workflow_id="support",
)
def summarize_ticket():
    return openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Summarize this ticket"}],
    )

completion = summarize_ticket()
flush(timeout=2.0)
```

```curl
curl -X POST "https://www.runtraice.com/api/v1/events" \
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

:::

`tenantId` is the key field for customer margin. Pass the customer or account id you bill on every product event.

## 4. Track Internal AI-Tool Spend

Internal Spend is separate from product events. The maintained collector supports Claude Code and Codex today. Send
other employee or team usage through the authenticated internal-usage API until native connectors are available.

Install the local collector for Claude Code:

```sh
npx @traice/collector@latest setup claude-code \
  --server-url https://www.runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering \
  --seat-monthly-usd 200
```

The command shows a short code, opens trAIce for approval, stores the renewable session in the operating system
credential manager, patches the agent settings, and installs a background user service. Rerunning it updates the
existing setup and reuses the saved authorization while it remains valid. Add `--no-browser` for SSH, or `--no-service`
if another process manager will run the collector. API keys remain supported for CI, containers, and other unattended
automation.

Send an internal usage row directly:

```sh
curl -X POST "https://www.runtraice.com/api/v1/internal-usage" \
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

## 5. Check The Dashboard

After the first product event lands, open [the dashboard](https://www.runtraice.com/app/dashboard). For customer margin, add revenue rows under Settings -> Customer revenue.

For Internal Spend, open Dashboard -> Internal Spend after collector events arrive.

## 6. Ask From The CLI Or An MCP Client

Save the same workspace API key in the operating system credential store, then ask a question:

```sh
npm install --global @traice/sdk
export TRAICE_API_KEY="lm_live_..."
traice auth login
unset TRAICE_API_KEY
traice ask "top spend by feature in the last 7 days"
```

Workspace owners and admins can connect Slack from Settings -> Ask trAIce -> Add to Slack. See [Ask trAIce](/docs/ask-traice) for Slack, Cursor, VS Code, MCP, CLI, and direct API setup.

## Next Steps

- [Product SDKs](sdk-quickstart)
- [TypeScript and Node.js SDK](typescript-sdk)
- [Python SDK](python-sdk)
- [HTTP and cURL](http-api)
- [OpenTelemetry and vendor imports](integrations)
- [Collector Overview](collector-overview)
- [Claude Code](claude-code)
- [Codex](codex)
