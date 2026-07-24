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
npx @traice/collector@latest auth login
npx @traice/collector@latest setup claude-code
```

Authorize the device in your browser, then setup patches user-level `~/.claude/settings.json`, installs a background
user service, and reports the result. You can run `setup` directly; it starts browser authorization when needed. It is
safe to rerun. Add `--no-browser` to `auth login` for SSH, or `--no-service` to setup if another process manager will
run collection.

Restart every running Claude Code session after setup. Sessions that were already running do not reload the telemetry
environment written to `~/.claude/settings.json`.

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
