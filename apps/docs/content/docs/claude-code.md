---
title: Claude Code
excerpt: Configure Claude Code telemetry for trAIce Internal Spend.
section: Internal spend
sectionOrder: 3
order: 2
---

# Claude Code

Run the complete setup:

```sh
npx @traice/collector@latest setup claude-code \
  --server-url https://www.runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering
```

The command opens a short-code browser authorization when a valid saved session is unavailable. It stores the session securely, patches user-level `~/.claude/settings.json`, installs a background user service, and reports the result. It is safe to rerun. Add `--no-browser` for SSH, or `--no-service` if another process manager will run collection.

Verify configuration, credentials, service state, the local listener, and server access:

```sh
npx @traice/collector@latest status
```

To run the collector in the foreground instead:

```sh
npx @traice/collector@latest collect --agent claude-code
```

Claude Code should export OTLP HTTP JSON to:

```text
http://127.0.0.1:4318
```

Prompt logging is off by default. Only pass `--include-prompts` when your organization has explicitly approved prompt collection. See [Privacy](/docs/privacy).

## Run continuously

Use the native service definitions in the [Codex guide](/docs/codex#background-service), replacing `--agent codex`
with `--agent claude-code`. Credentials remain in Keychain, Credential Manager, Secret Service, or the protected-file
fallback; never place a credential in a plist, systemd unit, or Windows Startup launcher.
