---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
order: 5
---

# Codex

Install:

```sh
npx @traice/collector@latest install codex \
  --server-url https://app.runtraice.com \
  --employee-email you@company.com \
  --team-name Engineering \
  --api-key-stdin
```

Add `--patch-settings` to patch user-level `~/.codex/config.toml` with the trAIce OTel block.

Start the collector:

```sh
npx @traice/collector@latest collect --agent codex
```

Codex project-local telemetry settings may not control routing. Prefer user-level configuration for device installs.
