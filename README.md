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

## Development

```sh
npm install
npm run check
```

This repository is intentionally curated from the private SaaS monorepo. Do not copy SaaS application code, environment files, database schemas, migrations, customer data, or Vercel configuration into this public repo.

## Documentation

Docs live in `apps/docs` and are reachable from https://runtraice.com/docs.
The app-owned `/docs` route redirects to the current GitHub Pages deployment.

## License

MIT
