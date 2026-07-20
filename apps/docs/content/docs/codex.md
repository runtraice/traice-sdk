---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
section: Internal spend
sectionOrder: 3
order: 3
---

# Codex

Set up Codex, start collection in the background, and backfill the previous 7 days:

```sh
npx @traice/collector@latest setup codex \
  --server-url https://www.runtraice.com \
  --employee-email you@company.com \
  --team-name Engineering
```

The command prompts for an API key only when a valid saved key is unavailable. It verifies and saves the key, patches
user-level `~/.codex/config.toml`, installs a background user service, and reports the backfill result. It is safe to
rerun. Use `--backfill-days N` for a 1 to 30 day window, `--no-backfill` to skip history, or `--no-service` if another
process manager will run collection.

Codex project-local telemetry settings may not control routing. Prefer user-level configuration for device installs.

## Windows setup

Use the command that matches the terminal. Command Prompt does not understand PowerShell backticks.

### Command Prompt

Keep the setup command on one line:

```bat
npx --yes @traice/collector@latest setup codex --server-url "https://www.runtraice.com" --employee-email "you@company.com" --team-name "Engineering" --backfill-days 7 --yes
```

### PowerShell

PowerShell supports a backtick at the end of each continued line:

```powershell
npx --yes @traice/collector@latest setup codex `
  --server-url 'https://www.runtraice.com' `
  --employee-email 'you@company.com' `
  --team-name 'Engineering' `
  --backfill-days 7 `
  --yes
```

Run setup as the Windows user whose Codex usage should be collected. Administrator access is not required. The API-key
prompt shows `****` after a key is pasted without revealing its value.

If `npx` is not recognized, install Node.js LTS, reopen the terminal, and rerun setup:

```bat
winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
```

If setup says that a saved API key was rejected, create a new collector key in the Internal Spend source modal and
paste the complete value. A rejected key is revoked, incomplete, associated with another trAIce workspace, or being
sent to the wrong trAIce server. Running as Administrator does not change API-key validation.

## Manual history backfill

Live collection does not replay old sessions automatically. To inspect a bounded window first:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

To upload the previous week through the time the command starts:

```sh
npx @traice/collector@latest backfill codex --since 7d
```

The collector snapshots the omitted `--until` boundary to the command start time. Backfill sends usage totals only,
uses stable IDs for retry-safe deduplication, and skips records already received by live collection. Duplicate rows are
reported as dropped and do not increase stored usage, token totals, or spend.

## Background service

`setup` installs and starts a user service automatically:

- **macOS:** install a user `launchd` LaunchAgent with `RunAtLoad` and `KeepAlive`.
- **Linux:** install a `systemd --user` service; enable it with `systemctl --user enable --now traice-collector`.
- **Windows:** install a hidden per-user Startup launcher with restart-on-failure behavior.

The service uses a persistent package runtime rather than an `npx` cache or shell-specific Node path. This lets it
start reliably at login. Credentials remain outside the service definition and are resolved from the reference in
`~/.traice/collector/config.json`.
