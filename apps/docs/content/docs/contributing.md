---
title: Contributing
excerpt: Standards for public package and adapter contributions.
section: Project
sectionOrder: 6
order: 1
---

# Contributing

Run the full check locally:

```sh
npm install
npm run check
```

Public contributions should include tests for behavior changes.

Documentation changes must keep language-specific guides isolated, use resolvable internal links, include complete frontmatter, and link public API claims to package source. The docs verifier runs as part of `npm run check`.

Build the static GitHub Pages output when changing navigation, Markdown rendering, or styles:

```sh
npm run docs:build
```

Do not copy these into the public repo:

- SaaS app source.
- Environment files.
- Database schemas or migrations.
- Customer data.
- Local collector state.
- Deployment configuration from private projects.

New collector adapters should start from official telemetry, API, or export surfaces when available.
