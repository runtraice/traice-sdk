---
title: Collector Overview
excerpt: Install, operate, and extend the local Claude Code and Codex usage collector.
section: Internal spend
sectionOrder: 3
order: 1
---

# Collector Overview

`@traice/collector` is the maintained local collector for employee and team AI-tool spend. It receives local
OpenTelemetry HTTP JSON from supported coding agents, normalizes usage into `InternalUsageEvent`, and forwards batches
to `/api/v1/internal-usage`.

Product SDK events and collector events are separate. Use the collector for employee tools, not customer-facing
product requests.

## Supported agents

| Agent       | Live input                      | Historical backfill           |
| ----------- | ------------------------------- | ----------------------------- |
| Claude Code | OTLP HTTP JSON logs and metrics | Not currently provided        |
| Codex       | OTLP HTTP JSON logs             | Optional local history, 1-30d |

## Recommended setup

Run one interactive command:

### macOS and Linux

```bash
npx @traice/collector@latest setup
```

### Windows terminals

Use the snippet for the terminal you opened. Administrator access is not required.

#### Command Prompt

```bat
npx @traice/collector@latest setup
```

#### PowerShell

PowerShell uses `npx.cmd` so a restrictive execution policy does not block `npx.ps1`.

```powershell
npx.cmd @traice/collector@latest setup
```

Use the same `npx` or `npx.cmd` prefix for the other collector commands below. If the selected command is not
recognized, install or repair Node.js LTS, reopen the terminal, and try again.

Setup detects supported agents, lets you choose which agents and workspace destinations to use, confirms employee and
team attribution, patches user-level telemetry settings, verifies access, and installs a background user service.
Browser authorization is started automatically when needed.

Local history is not imported by default. Add `--backfill-days N` to offer an optional, best-effort Codex history
import during setup. Add `--no-service` only when another process manager owns the collector.

Restart every running Codex or Claude Code session after setup. Existing sessions do not reload telemetry settings.

For SSH or another headless terminal:

```bash
npx @traice/collector@latest setup --no-browser
```

Open the printed URL on any device, enter the short code, then return to the terminal.

## Destinations and routes

A destination is one authorized trAIce workspace. A route maps one coding agent to one or more destinations. One
browser authorization can select multiple workspaces; each selected workspace receives its own scoped credential.

```bash
npx @traice/collector@latest destination list
npx @traice/collector@latest route list
npx @traice/collector@latest route set codex live-demo sandbox
npx @traice/collector@latest route set claude-code live-demo
```

`route list` shows the workspace, signed-in account, and server behind every destination:

```text
Collector routes

Codex -> 2 destinations
  - live-demo
    Live Demo | you@example.com | www.runtraice.com
  - sandbox
    Sandbox | you@example.com | www.runtraice.com

Claude Code -> 1 destination
  - live-demo
    Live Demo | you@example.com | www.runtraice.com

Precedence: command override, most specific folder route, agent default, single destination.
Each live event is sent to every destination selected by its winning route.
```

The collector uses one local listener and one background service for all enabled agents. Credentials, durable queues,
delivery retries, and server-side deduplication stay isolated per destination. Sending one event to two destinations
intentionally creates one row in each workspace.

### Repository and worktree routes

Add a folder override when one repository or worktree should use a different workspace:

```bash
npx @traice/collector@latest route set codex sandbox --folder "$PWD"
npx @traice/collector@latest route set all sandbox --folder "$PWD"
npx @traice/collector@latest route explain --agent codex --folder "$PWD"
```

Folder rules include the selected directory and all descendants, including nested repositories and worktree
directories. Add a separate rule for a linked worktree outside that directory tree. A more deeply nested rule wins
because the longest matching path takes priority. At the same path, a specific `codex` or `claude-code` rule wins over
`all`. `route explain` prints the winning rule and the fallback chain. `route list` marks agents without a default as
unresolved, and `status` reports counts of resolved and unresolved sessions while folder rules are active.

The complete precedence order is:

1. An explicit `--destination` command override
2. The longest matching folder and agent rule
3. The longest matching folder and `all` rule
4. The per-agent default route
5. The only configured destination

Remove one agent's rule or every rule for a folder:

```bash
npx @traice/collector@latest route remove --agent codex --folder "$PWD"
npx @traice/collector@latest route remove --folder "$PWD"
```

Folder routes can select only destinations already authorized on this device. Repository files cannot change them.
The collector resolves the current folder from local session metadata and never adds that path to uploaded events.

Add or remove one destination explicitly:

```bash
npx @traice/collector@latest auth login --destination sandbox --workspace sandbox
npx @traice/collector@latest auth logout --destination sandbox
```

A new authorization always uses the production trAIce service unless its login command explicitly selects another
deployment.

## Opt-in task context

Use destination-scoped context when the same device sends to workspaces that need different employee attribution or
task labels. Context is off until the user sets it:

```bash
npx @traice/collector@latest context set \
  --destination engineering-workspace \
  --employee-email engineer@example.com \
  --role "Staff Engineer" \
  --department Engineering \
  --repository auto \
  --description "Improve collector attribution" \
  --labels-json '{"workType":"product","priority":"p1"}'
```

Inspect or clear it:

```bash
npx @traice/collector@latest context show --destination engineering-workspace
npx @traice/collector@latest context clear --destination engineering-workspace
```

`--repository auto` reads the current Git remote only after this explicit opt-in. The collector caps descriptions at
280 characters and custom labels at 24 keys, three nesting levels, 2 KiB, 256 characters per string, and 20 array
items. The complete context is capped at 4 KiB. Secret-looking keys and values are redacted.

The context is stored on the same internal-usage rows as token and cost data. It does not require another model call,
enable prompt capture, or forward arbitrary OTLP attributes. Historical backfill keeps destination identity, role,
and department, but excludes the current task description, repository, and labels so old work is not mislabeled.

Trusted local applications can send normalized platform usage to
`http://127.0.0.1:4318/v1/internal-usage`. The loopback-only endpoint accepts at most 100 events per request, applies
the same destination routing and identity policy, and queues every destination durably. This lets local application
worktrees report their own model calls without storing a workspace API key in each checkout.

## Health and updates

```bash
npx @traice/collector@latest status
npx @traice/collector@latest update --check
npx @traice/collector@latest update
```

`status` checks the config, pinned service version, background service, local OTLP listener, and every unique
destination used by configured agent and folder routes. Each destination reports its credential and authenticated
server access separately. Use `status --destination <name>` for a focused check or `--json` for machine-readable
results. With folder routes active, status also reports how many observed sessions resolved a local folder and how
many fell back without one. The command exits non-zero when any required check fails and tells you when `update` is
required.

The service uses an exact installed package version. It checks for a newer stable release once per day and logs an
update notice. Read-only commands never persist a config migration underneath an older service. Commands that change
authorization or routes refresh an outdated installed service automatically. `update` installs the latest stable
runtime and restarts the single service explicitly.

## Durable delivery

The local listener binds to `127.0.0.1:4318`. Accepted telemetry is durably appended under
`~/.traice/collector/state/` before the listener returns HTTP 202. Every destination has an isolated outbox. Queued
events survive restarts, and a failing destination does not block the others.

Each outbox retains up to 10,000 events and drops its oldest event on overflow. The local health endpoint reports queue
depth, deduplication, drops, retries, failures, and recent delivery timestamps.

Run the listener in the foreground only when another service manager owns its lifecycle:

```bash
npx @traice/collector@latest collect
```

## Codex backfill

Backfill is optional because local Codex JSONL history can contain gaps. Live telemetry is the source of truth.

Inspect a bounded window:

```bash
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

Upload the previous week to a specific destination:

```bash
npx @traice/collector@latest backfill codex --destination live-demo --since 7d
```

When setup has recorded the first telemetry activation time, an omitted `--until` stops there so history does not
cross the normal live-collection boundary. Stable event IDs and paginated live-only reconciliation make interrupted
or repeated uploads retry-safe. Without `--destination`, backfill applies the same folder routing as live Codex
events. Duplicate rows do not increase stored usage, token totals, or spend.

## Configuration and credential storage

Non-secret device configuration is stored at:

```text
~/.traice/collector/config.json
```

The config contains destination metadata and credential references, agent and local folder routes, employee and team
mapping, adapter settings, and the local listener address. Folder paths stay in this local config and are never added
to uploaded events. Before replacing it, the CLI retains bounded backups under `~/.traice/collector/backups/`.

Renewable OAuth credentials are stored separately:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service
- A user-only protected file when an operating-system credential store is unavailable

Use `--credential-store keyring` to require the native store or `--credential-store file` for a headless,
externally encrypted environment. Do not place credentials in service definitions, shell history, or committed files.

Workspace API keys remain available for CI, containers, MDM, and unattended automation:

```bash
printf '%s\n' "$TRAICE_API_KEY" |
  npx @traice/collector@latest install codex \
    --destination ci \
    --api-key-stdin \
    --patch-settings
```

The environment value is not written into the collector config. Avoid `--api-key <value>` in shared shells.

## CLI reference

| Command                           | Purpose                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| `setup`                           | Detect agents, authorize destinations, configure routes and service |
| `auth login/status/logout`        | Add, inspect, or revoke browser authorization                       |
| `destination list`                | List authorized workspace destinations                              |
| `route list/set/remove/explain`   | Inspect and manage per-agent and folder workspace routes            |
| `context show/set/clear`          | Manage explicit destination-scoped identity and task labels         |
| `status`                          | Check configuration, credentials, service, listener, and access     |
| `collect`                         | Run the local listener in the foreground                            |
| `backfill codex --since <window>` | Inspect or upload bounded Codex history                             |
| `install <agent>`                 | Advanced unattended agent configuration                             |
| `update [--check]`                | Check for or install the latest stable collector                    |

Common options:

| Option                        | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `--agent <agent>`             | Preselect an agent during setup; repeat for more than one      |
| `--destination <name>`        | Select a destination; repeat where multiple values are allowed |
| `--workspace <slug-or-id>`    | Preselect a workspace during setup or explicit login           |
| `--server-url <url>`          | Use another trAIce deployment                                  |
| `--employee-email <email>`    | Set employee attribution                                       |
| `--team-name <name>`          | Set reporting team                                             |
| `--seat-monthly-usd <amount>` | Record an optional subscription commitment                     |
| `--backfill-days <1-30>`      | Offer an optional bounded Codex history import                 |
| `--no-service`                | Skip background service installation                           |
| `--no-browser`                | Print the authorization URL for SSH or another device          |
| `--credential-store <mode>`   | Select `auto`, `keyring`, or `file`                            |
| `--json`                      | Print machine-readable output                                  |

Run `npx @traice/collector@latest help <command>` for the complete option list.

## Privacy

The collector sends usage and allocation metadata from an explicit allowlist. Prompt and output capture is off by
default. See [Privacy](/docs/privacy) before enabling `--include-prompts`.

## Source and package

- [Package on npm](https://www.npmjs.com/package/@traice/collector)
- [Collector source](https://github.com/runtraice/traice-sdk/tree/main/packages/collector)
- [Collector README](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/README.md)
- [Event contract reference](/docs/event-reference)
