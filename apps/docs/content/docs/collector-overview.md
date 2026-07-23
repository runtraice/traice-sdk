---
title: Collector Overview
excerpt: Install, operate, and extend the local Claude Code and Codex usage collector.
section: Internal spend
sectionOrder: 3
order: 1
---

# Collector Overview

`@traice/collector` is the maintained local collector for employee and team AI-tool spend. It receives local OpenTelemetry HTTP JSON from supported coding agents, normalizes usage into `InternalUsageEvent`, and forwards batches to `/api/v1/internal-usage`.

Product SDK events and collector events are separate. Use the collector for employee tools, not customer-facing product requests.

## Supported agents

| Agent       | Input                           | Setup guide                      | Historical backfill                                       |
| ----------- | ------------------------------- | -------------------------------- | --------------------------------------------------------- |
| Claude Code | OTLP HTTP JSON logs and metrics | [Claude Code](/docs/claude-code) | Not currently provided                                    |
| Codex       | OTLP HTTP JSON logs             | [Codex](/docs/codex)             | Bounded local usage history, 1 to 30 days through `setup` |

## Recommended setup

Authorize the device, then run setup. Setup confirms identity, verifies server access, patches user-level agent
telemetry, installs a background user service, and runs the supported bounded backfill.

```bash
npx --yes @traice/collector@latest auth login
npx --yes @traice/collector@latest setup codex
```

You can run `setup` directly; it starts browser authorization when needed. Use `setup claude-code` for Claude Code.
Add `--no-service` when another process manager will own the collector. Add `--no-backfill` or `--backfill-days N`
for Codex history behavior.

The authorization URL can be opened on any device. For an SSH or headless session, add `--no-browser`, then open the printed URL and enter the code.

## Check collector health

```bash
npx @traice/collector@latest status
```

The status command checks:

- Configuration and enabled agents.
- Credential availability and storage backend.
- Background service installation and runtime state.
- Local OTLP listener reachability.
- trAIce server access.

The listener also exposes delivery health on its local health endpoint,
including queued event count, oldest queued event time, delivered and
deduplicated counts, overflow drops, retries, failures, and the latest delivery
timestamps.

Use `--json` for machine-readable health checks. The command exits non-zero when the aggregate status is not healthy.

## Run in the foreground

```bash
npx @traice/collector@latest collect
```

The default listener binds to `127.0.0.1:4318`. Use `--agent`, `--listen-host`, or `--listen-port` to override the saved configuration for one run.

The listener durably appends accepted local telemetry under
`~/.traice/collector/state/outbox.ndjson` before returning HTTP 202. It then
delivers strict batches in the background. A backend outage therefore does not
hold agent export requests open, and queued events survive collector restarts.
The outbox retains at most 10,000 events and drops the oldest event on overflow.

## Inspect Codex history

Dry-run a bounded window before upload:

```bash
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

Upload the previous week through the command start time:

```bash
npx @traice/collector@latest backfill codex --since 7d
```

Backfill uses stable source event IDs for retry-safe deduplication. It reports discovered files, sessions, usage events, invalid lines, duplicates, time boundaries, token totals, and accepted or dropped rows.

## Configuration and credentials

Private device configuration is stored at:

```text
~/.traice/collector/config.json
```

The file contains the trAIce server URL, non-secret authorization metadata and a credential reference, employee and team mapping, enabled adapters, sources, and local listener settings. Short-lived access and rotating refresh credentials are stored separately:

- macOS Keychain.
- Windows Credential Manager.
- Linux Secret Service.
- A user-only protected file when an operating-system credential store is unavailable.

Use `--credential-store keyring` to require the native store or `--credential-store file` to explicitly select the protected-file backend. Do not place credentials in a launchd plist, systemd unit, Windows Startup launcher, shell history, or committed configuration.

On Windows, setup runs for the current user and does not require Administrator access. It creates a hidden Startup
launcher and keeps its credential in Windows Credential Manager. See the [Codex Windows setup](/docs/codex#windows-setup)
for separate Command Prompt and PowerShell commands, Node.js installation, and rejected-key troubleshooting.

## CLI commands

| Command                           | Purpose                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `auth login/status/logout`        | Authorize, inspect, or revoke the saved collector session                      |
| `setup <agent>`                   | Configure, validate, backfill when supported, and install a background service |
| `install <agent>`                 | Configure one agent without service installation or history backfill           |
| `status`                          | Check configuration, credentials, service, listener, and server access         |
| `collect`                         | Run the OTLP listener and forward normalized events                            |
| `backfill codex --since <window>` | Inspect or upload bounded Codex history                                        |
| `help [command]`                  | Show current command and option help                                           |

The CLI implementation is public in [`packages/collector/src/cli.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/src/cli.ts).

### Common parameters

The recommended commands omit defaults and ask for missing identity choices. Use these parameters for advanced or
unattended configuration:

| Option                        | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `--server-url <url>`          | Use staging or another trAIce deployment                      |
| `--workspace <slug-or-id>`    | Preselect a workspace during browser authorization            |
| `--employee-email <email>`    | Set the employee identity without an interactive question     |
| `--employee-name <name>`      | Set the optional employee display name                        |
| `--team-name <name>`          | Set the reporting team without an interactive question        |
| `--seat-monthly-usd <amount>` | Record an optional per-seat subscription commitment           |
| `--backfill-days <1-30>`      | Change the default 7-day Codex backfill                       |
| `--no-backfill`               | Skip Codex history                                            |
| `--no-service`                | Do not install the background service                         |
| `--no-browser`                | Print the authorization link for SSH or another device        |
| `--credential-store <mode>`   | Select `auto`, `keyring`, or `file`                           |
| `--yes`                       | Accept defaults for an explicitly configured unattended setup |

Run `npx @traice/collector@latest help <command>` for every supported option.

## Programmatic API

The package root exports setup, installation, status, service, credential, configuration, backfill, run, and normalization functions. The supported entrypoint is [`packages/collector/src/index.ts`](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/src/index.ts).

Primary APIs include:

- `setupAgent`, `installAgent`, and `verifyCollectorConnection`.
- `loginAndStoreCollectorAuthorization`, `resolveCollectorAccessToken`, and `logoutCollector`.
- `getCollectorStatus`, `getCollectorServiceStatus`, and `formatCollectorStatus`.
- `runCollector`, `backfillCodex`, and `dryRunCodexBackfill`.
- `normalizeClaudeCodeOtlpLogs`, `normalizeClaudeCodeOtlpMetrics`, and `normalizeCodexOtlpLogs`.
- `loadCollectorConfig`, `writeCollectorConfig`, `readCollectorCredential`, and `storeCollectorCredential`.

Use the CLI for normal device installation. The programmatic surface is intended for managed installers, tests, and custom operational tooling.

## Privacy

The collector sends usage and allocation metadata from an explicit allowlist.
Prompt and output capture is off by default. See [Privacy](/docs/privacy)
before enabling `--include-prompts`.

## Source and package

- [Package on npm](https://www.npmjs.com/package/@traice/collector)
- [Collector source](https://github.com/runtraice/traice-sdk/tree/main/packages/collector)
- [Collector README](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/README.md)
- [Event contract reference](/docs/event-reference)
