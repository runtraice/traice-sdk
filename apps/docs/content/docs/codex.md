---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
order: 5
---

# Codex

Install:

```sh
npx @traice/collector@latest install codex \
  --server-url https://runtraice.com \
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

## Optional history backfill

Live collection does not replay old sessions automatically. To inspect a bounded window first:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

To upload it, include an exclusive cutoff so the replay cannot overlap an unbounded live stream:

```sh
npx @traice/collector@latest backfill codex --since 14d --until 2026-07-18T14:30:00Z
```

Backfill sends usage totals only, uses stable IDs for retry-safe deduplication, and skips records already received by live collection.
