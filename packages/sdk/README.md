# @traice/sdk

Runtime LLM cost attribution for TypeScript and JavaScript applications.

## Install

```sh
npm install @traice/sdk
```

## TypeScript

```ts
import { configure, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const completion = await meter(
  "ticket-summary",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    userId: "user_123",
    tenantId: "acme",
    env: process.env.NODE_ENV ?? "development",
  },
);
```

## JavaScript

```js
const { configure, meter } = require("@traice/sdk");

configure({
  adapters: ["local"],
  localPath: "./.traice-costs/events.ndjson",
});
```

ES modules work too:

```js
import { configure, meter } from "@traice/sdk";
```

## CLI

```sh
npx @traice/sdk report --file ./.traice-costs/events.ndjson
npx @traice/sdk forecast
npx @traice/sdk anomalies --threshold 2
```

## Adapters

- `console`: print cost events locally.
- `local`: write newline-delimited JSON to disk.
- `cloud`: send product runtime events to trAIce.
- `webhook`: send events to an HTTP endpoint.
- `otel`: emit OpenTelemetry metrics.

## Privacy

Prompts and outputs are not required for cost attribution. Only pass `prompt` or `output` when your workspace has explicitly opted into sample capture.
