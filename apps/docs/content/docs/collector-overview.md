---
title: Collector Overview
excerpt: One local collector package with per-agent adapters.
order: 3
---

# Collector Overview

`@traice/collector` is a unified CLI for internal AI-tool spend collection.

```sh
npx @traice/collector@latest install claude-code --api-key-stdin
npx @traice/collector@latest collect
```

The collector stores private device configuration at:

```text
~/.traice/collector/config.json
```

The config includes the trAIce server URL, API key, employee/team mapping, enabled adapters, and local OTLP listener settings.

Agent adapters normalize telemetry into the shared `@traice/protocol` `InternalUsageEvent` shape.

## Current Adapters

- Claude Code via OTLP HTTP JSON logs and metrics.
- Codex via OTLP HTTP JSON logs.

## Planned Adapters

Future adapters can use official vendor APIs, exports, or local telemetry where available. The collector should not scrape private unstable files unless the adapter is isolated by tests and there is no official path.
