---
title: Claude Code
excerpt: Configure Claude Code telemetry for trAIce Internal Spend.
order: 4
---

# Claude Code

Install:

```sh
printf "trAIce API key: "
stty -echo
IFS= read -r TRAICE_API_KEY
stty echo
printf "\n"
printf "%s" "$TRAICE_API_KEY" | npx @traice/collector@latest install claude-code \
  --api-key-stdin \
  --server-url https://app.runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering
unset TRAICE_API_KEY
```

The installer prints the settings snippet by default. Add `--patch-settings` to patch `~/.claude/settings.json`.

Start the collector:

```sh
npx @traice/collector@latest collect --agent claude-code
```

Claude Code should export OTLP HTTP JSON to:

```text
http://127.0.0.1:4318
```

Prompt logging is off by default. Only pass `--include-prompts` when your organization has explicitly approved prompt collection.
