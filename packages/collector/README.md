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

Add one explicitly named destination:

```sh
npx @traice/collector@latest auth login --destination sandbox --workspace sandbox
```

New authorization defaults to the production trAIce service and never inherits another destination's deployment.

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

Backfill uses stable source event IDs and paginated live-only reconciliation. Repeated or interrupted uploads are
retry-safe. Duplicates do not increase stored usage or spend.

## Credentials

Non-secret configuration lives at `~/.traice/collector/config.json`. Renewable credentials are stored in macOS
Keychain, Windows Credential Manager, or Linux Secret Service. If a native store is unavailable, `auto` mode uses a
user-only protected file and reports the fallback.

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
