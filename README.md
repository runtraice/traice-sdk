# trAIce SDK

Public SDKs and coding-agent collectors for trAIce.

## Packages

| Package             | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `@traice/sdk`       | TypeScript runtime LLM cost attribution.         |
| `traice-sdk`        | Python runtime collection, imported as `traice`. |
| `@traice/collector` | Local collector for coding-agent usage signals.  |
| `@traice/protocol`  | Shared event schemas and normalization helpers.  |

## Agent-assisted setup

Install the public setup skills, then ask your coding agent to run `$setup-traice` in the repository you want to
instrument:

```sh
npx skills add runtraice/traice-sdk \
  --skill setup-traice \
  --skill setup-traice-sdk \
  --skill setup-traice-collector \
  -g -y
```

`setup-traice` detects whether the repository needs the product SDK, the local Codex and Claude Code collector, or
both. If no account exists, it opens trAIce sign-in and waits. Product API keys use hidden terminal entry or a
deployment secret manager and never need to enter agent chat. Interactive collectors use browser authorization and do
not require an API key.

Read the [agent setup guide](apps/docs/content/docs/agent-setup.md) for the onboarding prompt and security behavior.

## Install

TypeScript, JavaScript, and Python projects are supported.

```sh
npm install @traice/sdk
```

```ts
import { configure, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const result = await meter(
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  { feature: "assistant-reply", userId: "user_123", tenantId: "acme" },
);
```

CommonJS works too:

```js
const { configure, meter } = require("@traice/sdk");
```

Python applications install `traice-sdk` from PyPI and import `traice`. The [Python SDK guide](https://runtraice.github.io/traice-sdk/docs/python-sdk) covers decorators, context managers, batching, and LangChain callbacks.

## Runtime performance

Local SDK overhead per tracked LLM call stayed under 1 ms at p99 across the
Node.js and Python GCP benchmark matrix with default buffered delivery. Network
delivery and opt-in guardrails are measured separately. Read the [runtime
architecture and performance
guide](https://runtraice.github.io/traice-sdk/docs/runtime-performance) for the
client-side flow, benchmark method and results, limits, and serverless
workarounds.

```sh
pnpm run benchmark:sdk
```

## Coding-Agent Collection

```sh
npx @traice/collector@latest setup
```

Setup detects installed agents, starts browser authorization when needed, stores renewable sessions in the operating
system credential store, confirms employee mapping, patches selected agent settings, and installs a background user
service. API keys remain available for unattended automation.
Collectors send internal usage rows to `/api/v1/internal-usage`. Product-runtime SDK events still go to
`/api/v1/events`.

Restart every running coding-agent session after setup so it loads the new telemetry settings.

## Repository benchmarks

Use the open-source [`benchmark-repo` skill](skills/benchmark-repo/SKILL.md) to compare the same coding-agent prompt
suite with and without Graphify or another Candidate tool. It records tokens, cost, time, quality, setup, required
refreshes, and privacy-safe activity aggregates. Read the
[Repository Benchmarks guide](https://runtraice.github.io/traice-sdk/docs/repository-benchmarks) for the exact prompt,
protocol, upload flow, and public-report privacy boundary.

## Ask trAIce

The SDK also ships the `traice` CLI. Save a workspace API key once in the operating system credential store, then query the same attributed data available through the dashboard and MCP endpoint:

```sh
npm install --global @traice/sdk
export TRAICE_API_KEY="lm_live_..."
traice auth login
unset TRAICE_API_KEY
traice ask "which customers are unprofitable this month?"
```

Workspace owners and admins can also connect Slack from trAIce Settings and use `/traice` or mention the app. See the [Ask trAIce guide](apps/docs/content/docs/ask-traice.md) for Slack, Cursor, VS Code, MCP, CLI, and direct API setup.

OAuth-capable remote MCP clients only need `https://www.runtraice.com/api/mcp`. The client opens trAIce for sign-in and
explicit workspace consent, then stores and refreshes its OAuth session. API keys remain available for unattended MCP
clients.

Team workspaces can prepare budgets, alert snoozes, and evidence-gated shadow guardrails. Every write uses a separate short-lived token and exact confirmation phrase; preparation never makes a change:

```sh
traice action prepare-budget --name "Support" --limit-usd 500
```

## Existing telemetry and gateways

trAIce accepts OTLP HTTP/JSON GenAI spans and the CLI can backfill normalized LiteLLM or Langfuse cost data. Vendor credentials remain local, input/output fields are not imported, and repeated backfills use stable source IDs instead of creating duplicate usage. See [OpenTelemetry and vendor imports](apps/docs/content/docs/integrations.md).

## Development

pnpm is the canonical lockfile and CI installer. The repository does not
enforce a local package manager, and locally generated npm, Yarn, or Bun
lockfiles stay uncommitted.

```sh
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install
pnpm run check
```

Published-package changes require a Changeset. A reviewed version PR is the
publish gate; ordinary merges do not publish. See
[CONTRIBUTING.md](CONTRIBUTING.md#releases).

This repository is intentionally curated from the private SaaS monorepo. Do not copy SaaS application code, environment files, database schemas, migrations, customer data, or Vercel configuration into this public repo.

## Documentation

Docs live in `apps/docs` and are reachable from https://runtraice.com/docs.
The app-owned `/docs` route redirects to the current GitHub Pages deployment.

## License

MIT
