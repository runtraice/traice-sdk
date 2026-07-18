---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
order: 5
---

# Codex

Install:

```sh
npx @traice/collector@latest install codex \
  --server-url https://www.runtraice.com \
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

To upload the previous week through the time the command starts:

```sh
npx @traice/collector@latest backfill codex --since 7d
```

The collector snapshots the omitted `--until` boundary to the command start time. Backfill sends usage totals only,
uses stable IDs for retry-safe deduplication, and skips records already received by live collection. Duplicate rows are
reported as dropped and do not increase stored usage, token totals, or spend.

## Run continuously at startup

For unattended collection, install the collector as a user service. Keep live collection and historical replay as
separate processes so a replay can be retried without interrupting telemetry:

- **macOS:** install a user `launchd` LaunchAgent with `RunAtLoad` and `KeepAlive`.
- **Linux:** install a `systemd --user` service; enable it with `systemctl --user enable --now traice-collector`.
- **Windows:** create a per-user Task Scheduler task triggered at logon with restart-on-failure enabled.

The service should run `collect --agent codex`. Run backfill separately; an omitted `--until` is fixed to the command
start time. Both modes are safe to run together: event IDs are stable and the server deduplicates retries and
live/history overlap.

### macOS LaunchAgent

This creates and starts a per-user LaunchAgent. It starts at login and restarts after failure:

```sh
npm install --global @traice/collector@latest
TRAICE_COLLECTOR_BIN="$(command -v traice-collector)"
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.traice.collector.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.traice.collector</string>
  <key>ProgramArguments</key><array>
    <string>${TRAICE_COLLECTOR_BIN}</string><string>collect</string><string>--agent</string><string>codex</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/traice-collector.log</string>
  <key>StandardErrorPath</key><string>/tmp/traice-collector.err</string>
</dict></plist>
PLIST
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.traice.collector.plist >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.traice.collector.plist
```

### Linux systemd user service

This creates, enables, and starts a per-user systemd service:

```sh
npm install --global @traice/collector@latest
TRAICE_COLLECTOR_BIN="$(command -v traice-collector)"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/traice-collector.service <<UNIT
[Unit]
Description=trAIce collector
After=network-online.target

[Service]
ExecStart=${TRAICE_COLLECTOR_BIN} collect --agent codex
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now traice-collector
```

### Windows Task Scheduler

Run in PowerShell after installing the CLI globally:

```powershell
npm install --global @traice/collector@latest
$collector = (Get-Command traice-collector.cmd -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $collector -Argument "collect --agent codex"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 100 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "trAIce Collector" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "trAIce Collector"
```

Credentials remain outside these service definitions. The collector resolves its Keychain, Credential Manager, Secret
Service, or protected-file credential reference from `~/.traice/collector/config.json` at startup.
