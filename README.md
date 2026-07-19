# trAIce SDK

Public SDKs and coding-agent collectors for trAIce.

## Packages

| Package             | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `@traice/sdk`       | Runtime LLM cost attribution for your product.  |
| `@traice/collector` | Local collector for coding-agent usage signals. |
| `@traice/protocol`  | Shared event schemas and normalization helpers. |

## Install

TypeScript and JavaScript projects are both supported.

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
  "assistant-reply",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  { userId: "user_123", tenantId: "acme" },
);
```

CommonJS works too:

```js
const { configure, meter } = require("@traice/sdk");
```

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

See the [Ask trAIce guide](apps/docs/content/docs/ask-traice.md) for Cursor, VS Code, MCP, and direct API setup.

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
