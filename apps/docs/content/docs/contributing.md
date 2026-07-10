---
title: Contributing
excerpt: Standards for public package and adapter contributions.
order: 8
---

# Contributing

Run the full check locally:

```sh
npm install
npm run check
```

Public contributions should include tests for behavior changes.

Do not copy these into the public repo:

- SaaS app source.
- Environment files.
- Database schemas or migrations.
- Customer data.
- Local collector state.
- Deployment configuration from private projects.

New collector adapters should start from official telemetry, API, or export surfaces when available.
