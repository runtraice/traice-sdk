---
title: API Reference
excerpt: Public package exports and event contracts.
order: 7
---

# API Reference

## `@traice/sdk`

Main exports:

- `configure`
- `meter`
- `meterStream`
- `flush`
- `resetConfig`
- `getConfig`
- `getMeterStats`
- `ConsoleAdapter`
- `LocalAdapter`
- `CloudAdapter`
- `WebhookAdapter`
- `OTelAdapter`

## `@traice/collector`

Main exports:

- `installAgent`
- `runCollector`
- `normalizeClaudeCodeOtlpLogs`
- `normalizeClaudeCodeOtlpMetrics`
- `normalizeCodexOtlpLogs`

CLI:

```sh
npx @traice/collector@latest install claude-code
npx @traice/collector@latest install codex
npx @traice/collector@latest collect
```

## `@traice/protocol`

Main exports:

- `InternalUsageEvent`
- `ProductUsageEvent`
- `normalizeInternalUsageEvent`
- `assertValidInternalUsageEvent`
- `redactMetadata`
- `stableSourceEventId`
