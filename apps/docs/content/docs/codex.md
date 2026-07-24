---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
section: Internal spend
sectionOrder: 3
order: 3
---

# Codex

Set up Codex and start live collection in the background:

```sh
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

Confirm the short code and workspace in your browser. Setup patches user-level `~/.codex/config.toml` and installs a
background user service. You can run `setup` directly; it starts browser authorization when needed. It is safe to
rerun. Use `--backfill-days N` to request a 1 to 30 day best-effort history import, or `--no-service` if another
process manager will run collection. Over SSH, add `--no-browser` to `auth login` and open the printed URL on any
device.

Restart every running Codex session after setup. Codex reads its OTel configuration when a session starts, so sessions
that were already running will not begin exporting live usage.

Setup merges trAIce-managed keys into an existing `[otel]` table, preserves unrelated OTel settings, and repairs
duplicate tables created by older collector setup. Rerunning setup updates the same table instead of appending another
one. It also restarts the existing service and retries the bounded backfill. Stable event IDs keep repeated backfills
idempotent.

Codex project-local telemetry settings may not control routing. Prefer user-level configuration for device installs.

## Multiple workspaces

Codex still exports to one local collector endpoint. To send usage to a shared demo workspace and a testing workspace,
authorize both destinations and set the Codex route:

```sh
npx @traice/collector@latest auth login --profile live-demo --workspace live-demo
npx @traice/collector@latest auth login --profile test-zoro --workspace test-zoro
npx @traice/collector@latest route set codex live-demo test-zoro
npx @traice/collector@latest destination list
```

The existing background service notices the updated route without another setup run. Each workspace has its own secure
credential, durable outbox, and deduplication boundary.

## Windows setup

Use the command that matches the terminal. Command Prompt does not understand PowerShell backticks.

### Command Prompt

Run these commands one at a time:

```bat
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

### PowerShell

Run the same commands one at a time:

```powershell
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

Run setup as the Windows user whose Codex usage should be collected. Administrator access is not required. The
browser-authorized session is stored in Windows Credential Manager.

If `npx` is not recognized, install Node.js LTS, reopen the terminal, and rerun setup:

```bat
winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
```

If a saved browser authorization has expired or was revoked, rerun `auth login` or `setup`. Use `auth status` to verify
the saved workspace and `auth logout` to revoke the grant and remove it from this device.

## Manual history backfill

Live collection does not replay old sessions automatically. Local JSONL can contain gaps, so treat backfill as a
best-effort supplement rather than the source of truth. To inspect a bounded window first:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

To upload the previous week:

```sh
npx @traice/collector@latest backfill codex --since 7d
```

When setup has recorded a telemetry activation time, an omitted `--until`
stops there so history does not cross the normal live-collection boundary.
Older configs fall back to the command start time. Backfill sends usage totals
only, uses stable IDs and paginated live-only reconciliation, and skips records
already received by live collection. Duplicate rows are reported as dropped
and do not increase stored usage, token totals, or spend.

## Background service

`setup` installs and starts a user service automatically:

- **macOS:** install a user `launchd` LaunchAgent with `RunAtLoad` and `KeepAlive`.
- **Linux:** install a `systemd --user` service; enable it with `systemctl --user enable --now traice-collector`.
- **Windows:** install a hidden per-user Startup launcher with restart-on-failure behavior.

The service uses a persistent package runtime rather than an `npx` cache or shell-specific Node path. This lets it
start reliably at login. Credentials remain outside the service definition and are resolved from the reference in
`~/.traice/collector/config.json`.
