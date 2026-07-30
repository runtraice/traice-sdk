# @traice/collector

Local coding-agent usage collector for trAIce Internal Spend.

## Interactive setup

```sh
npx @traice/collector@latest setup
```

Setup detects Codex and Claude Code, lets you select agents and workspace destinations, confirms attribution and local
changes, patches each selected agent, and installs one background user service. It starts OAuth 2.0 device
authorization when no suitable destination exists.

Restart every running coding-agent session after setup. Existing sessions do not reload telemetry settings.

Setup does not import local history by default. Add `--backfill-days 7` to offer an optional Codex import:

```sh
npx @traice/collector@latest setup --backfill-days 7
```

Local JSONL history can contain gaps, so live telemetry remains the source of truth.

## Destinations and routing

One browser authorization can connect multiple workspaces. Every workspace is stored as a separate destination with
its own scoped credential, durable queue, retries, and deduplication boundary.

```sh
npx @traice/collector@latest destination list
npx @traice/collector@latest route list
npx @traice/collector@latest route set codex live-demo sandbox
npx @traice/collector@latest route set claude-code live-demo
```

`route list` prints a readable agent-to-workspace map, including the account and server behind every destination.

Override routing for one repository or worktree:

```sh
npx @traice/collector@latest route set codex sandbox --folder "$PWD"
npx @traice/collector@latest route set all sandbox --folder "$PWD"
npx @traice/collector@latest route explain --agent codex --folder "$PWD"
npx @traice/collector@latest route remove --agent codex --folder "$PWD"
```

Folder routes match descendants, so one repository rule covers its worktrees unless a more specific worktree rule
exists. Precedence is explicit command override, longest matching folder route, per-agent route, then the single
configured destination. At the same folder, an agent-specific rule wins over `all`. `route explain` shows the winning
rule and its complete fallback chain. `status` reports resolved and unresolved local sessions when folder rules exist.

Add one explicitly named destination:

```sh
npx @traice/collector@latest auth login --destination sandbox --workspace sandbox
```

New authorization defaults to the production trAIce service and never inherits another destination's deployment.

## Opt-in task context

Identity and task context can be scoped to one destination. Nothing beyond normal usage metadata is added until the
user runs `context set`.

```sh
npx @traice/collector@latest context set \
  --destination engineering-workspace \
  --employee-email engineer@example.com \
  --role "Staff Engineer" \
  --department Engineering \
  --repository auto \
  --description "Improve collector attribution" \
  --labels-json '{"workType":"product","priority":"p1"}'

npx @traice/collector@latest context show --destination engineering-workspace
npx @traice/collector@latest context clear --destination engineering-workspace
```

`--repository auto` reads the current local Git remote only when explicitly requested. Descriptions are limited to
280 characters. Labels must be a JSON object and are limited to 24 keys, three nesting levels, 2 KiB, 256 characters
per string, and 20 items per array. Secret-looking keys and values are redacted. The complete manual context is capped
at 4 KiB.

Context is added to the same internal-usage row as model, token, and cost data, so existing spend reporting attributes
the cost to the selected labels. This command does not ask an LLM to classify work and does not collect prompts or raw
OTLP payloads. Historical backfill keeps destination identity, role, and department, but excludes the current task
description, repository, and labels so old work is not mislabeled.

Local applications can also send normalized platform usage to
`http://127.0.0.1:4318/v1/internal-usage`. The endpoint accepts a bounded `{ "events": [...] }` payload, applies the
collector's destination routing and identity policy, and uses the same durable per-destination outboxes. It is intended
for trusted applications on the same device and is never exposed beyond the collector's loopback listener.

## Health, service, and updates

```sh
npx @traice/collector@latest status
npx @traice/collector@latest update --check
npx @traice/collector@latest update
```

By default, `status` checks every unique destination used by the configured agent routes. Each destination reports
its credential and authenticated server access separately. Use `status --destination <name>` for a focused check.

The service starts at user login and restarts on failure:

- macOS: a `launchd` LaunchAgent
- Linux: a `systemd --user` service
- Windows: a hidden per-user Startup launcher

Administrator access is not required. The service runs an exact installed package version. `status` reports when the
CLI and service versions differ. Config inspection does not persist a schema migration underneath an older service,
and commands that change destinations or routes refresh an outdated installed service automatically. `update`
installs the latest stable runtime and restarts the service explicitly.

## Durable delivery

The listener binds to `127.0.0.1:4318`. It writes accepted telemetry to an isolated destination outbox under
`~/.traice/collector/state/` before returning HTTP 202. Queues survive restarts. A failing destination does not block
the others. Each outbox retains at most 10,000 events.

Run in the foreground only when another process manager owns the collector:

```sh
npx @traice/collector@latest collect
```

## Codex backfill

Inspect local history without sending it:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

Upload a bounded window:

```sh
npx @traice/collector@latest backfill codex --destination live-demo --since 7d
```

Without `--destination`, Codex backfill uses the same folder and agent routing rules as live collection. Backfill uses
stable source event IDs and paginated live-only reconciliation. Repeated or interrupted uploads are retry-safe.
Duplicates do not increase stored usage or spend.

## Credentials

Non-secret configuration lives at `~/.traice/collector/config.json`. Renewable credentials are stored in macOS
Keychain, Windows Credential Manager, or Linux Secret Service. If a native store is unavailable, `auto` mode uses a
user-only protected file and reports the fallback.

Folder paths are read from local session metadata and remain in the local collector config. They are used only to
choose an already-authorized destination and are not added to uploaded events.

For SSH:

```sh
npx @traice/collector@latest setup --no-browser
```

For unattended API-key automation:

```sh
printf '%s\n' "$TRAICE_API_KEY" |
  npx @traice/collector@latest install codex \
    --destination ci \
    --api-key-stdin \
    --patch-settings
```

The API key is stored through the selected credential backend, not in `config.json`. Avoid passing secrets directly
on a shared command line.

## Important options

| Option                        | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `--agent <agent>`             | Preselect an agent in setup; repeat for more than one |
| `--destination <name>`        | Select a workspace destination                        |
| `--workspace <slug-or-id>`    | Preselect a workspace during setup or explicit login  |
| `--server-url <url>`          | Use another trAIce deployment                         |
| `--employee-email <email>`    | Set employee attribution                              |
| `--team-name <name>`          | Set reporting team                                    |
| `--seat-monthly-usd <amount>` | Record an optional subscription commitment            |
| `--backfill-days <1-30>`      | Offer an optional bounded Codex history import        |
| `--no-service`                | Skip background service installation                  |
| `--no-browser`                | Print the authorization URL instead of opening it     |
| `--credential-store <mode>`   | Select `auto`, `keyring`, or `file`                   |
| `--json`                      | Print machine-readable output                         |

Run `npx @traice/collector@latest help <command>` for the full CLI reference.
