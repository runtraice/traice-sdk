---
title: SDK Quickstart
excerpt: Install @traice/sdk and send product-runtime LLM cost events.
order: 2
---

# SDK Quickstart

Install the SDK:

```sh
npm install @traice/sdk
```

TypeScript:

```ts
import { configure, meter } from "@traice/sdk";

configure({
  adapters: ["cloud"],
  cloudApiKey: process.env.TRAICE_API_KEY,
});

const completion = await meter(
  "support-summary",
  () =>
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize this ticket" }],
    }),
  {
    userId: "user_123",
    tenantId: "acme",
    workflowId: "support",
  },
);
```

JavaScript:

```js
const { configure, meter } = require("@traice/sdk");

configure({
  adapters: ["local"],
  localPath: "./.traice-costs/events.ndjson",
});
```

The package ships TypeScript declarations plus ESM and CommonJS builds.
