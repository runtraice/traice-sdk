# trAIce SDK

Public SDKs and coding-agent collectors for trAIce.

## Packages

| Package             | Purpose                                          |
| ------------------- | ------------------------------------------------ |
| `@traice/sdk`       | TypeScript runtime LLM cost attribution.         |
| `traice-sdk`        | Python runtime collection, imported as `traice`. |
| `@traice/collector` | Local collector for coding-agent usage signals.  |
| `@traice/protocol`  | Shared event schemas and normalization helpers.  |

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

## Coding-Agent Collection

```sh
npx @traice/collector@latest install claude-code \
  --server-url https://runtraice.com \
  --employee-email you@company.com \
  --team-name Engineering

npx @traice/collector@latest collect
```

Collectors send internal usage rows to `/api/v1/internal-usage`. Product-runtime SDK events still go to `/api/v1/events`.

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

Team workspaces can prepare budgets, alert snoozes, and evidence-gated shadow guardrails. Every write uses a separate short-lived token and exact confirmation phrase; preparation never makes a change:

```sh
traice action prepare-budget --name "Support" --limit-usd 500
```

## Existing telemetry and gateways

trAIce accepts OTLP HTTP/JSON GenAI spans and the CLI can backfill normalized LiteLLM or Langfuse cost data. Vendor credentials remain local, input/output fields are not imported, and repeated backfills use stable source IDs instead of creating duplicate usage. See [OpenTelemetry and vendor imports](apps/docs/content/docs/integrations.md).

## Development

```sh
npm install
npm run check
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
