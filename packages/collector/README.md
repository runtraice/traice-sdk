# @traice/collector

Unified local collector for coding-agent usage.

## Claude Code

```sh
npx @traice/collector@latest install claude-code \
  --server-url https://runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering \
  --api-key-stdin

npx @traice/collector@latest collect
```

By default, the installer prints the Claude Code settings snippet instead of modifying your settings file. Add `--patch-settings` to patch `~/.claude/settings.json`.

Prompt logging stays disabled unless you explicitly pass `--include-prompts`.

## Codex

```sh
npx @traice/collector@latest install codex --server-url https://runtraice.com --api-key-stdin
npx @traice/collector@latest collect --agent codex
```

The maintained collector forwards live OTLP telemetry only; it does not scan
or replay an unbounded history of local session files. Stop any legacy Codex
collector process before starting `@traice/collector`.

## JavaScript

```js
const { normalizeClaudeCodeOtlpLogs } = require("@traice/collector");
```
