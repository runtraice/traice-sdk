# @traice/collector

Unified local collector for coding-agent usage.

## Claude Code

```sh
npx @traice/collector@latest auth login
npx @traice/collector@latest setup claude-code
```

Authorize the device in your browser, then run `setup` to patch the agent settings and install a background user
service. You can also run `setup` directly; it starts browser authorization when a valid saved session is unavailable.
You do not need to copy an API key. Both commands are safe to rerun.

Interactive setup compares the requested employee email with the local Git email and asks which identity to use. It
also confirms a standard team name, the telemetry change, and background service installation. Use `--yes` with
explicit flags only for reviewed unattended installation.

Restart every running Claude Code session after setup. Sessions already running when telemetry is configured do not
reload the new settings.

Prompt logging stays disabled unless you explicitly pass `--include-prompts`.

## Codex

```sh
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

Codex setup does not import local history by default. Pass `--backfill-days` from 1 to 30 to request a best-effort
history import, then approve that step interactively. Local JSONL history can contain gaps, so live telemetry remains
the source of truth. Use `--no-service` when another process manager will run the collector. Rerunning setup replaces
the single managed block in `~/.codex/config.toml` and restarts the existing service. It does not append duplicate
Codex configuration.

Restart every running Codex session after setup. Sessions already running when telemetry is configured do not reload
the new OTel settings.

### Windows

Run these commands one at a time in Command Prompt:

```bat
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

Run the same two commands one at a time in PowerShell:

```powershell
npx @traice/collector@latest auth login
npx @traice/collector@latest setup codex
```

Setup uses a hidden per-user Startup launcher, so Administrator access is not required. If `npx` is unavailable,
install Node.js LTS with `winget install --id OpenJS.NodeJS.LTS --exact`, reopen the terminal, and retry. Setup opens
the browser for approval and stores the resulting session in Windows Credential Manager.

## Status and help

Check the saved configuration, credential, background service, local listener, and authenticated server connection:

```sh
npx @traice/collector@latest status
```

The command exits with code 0 when collection is healthy and code 1 when a required check fails. Use `--json` for
scripts and device management. Status output never includes the API key.

List commands or open help for one command:

```sh
npx @traice/collector@latest help
npx @traice/collector@latest help setup
```

The maintained collector forwards live OTLP telemetry only; it does not scan
or replay an unbounded history of local session files. Stop any legacy Codex
collector process before starting `@traice/collector`.

Live telemetry is durably queued under `~/.traice/collector/state/` before the
local listener returns HTTP 202. The default profile uses `outbox.ndjson`;
named profiles have separate workspace outboxes. Backend delivery runs
asynchronously in batches, honors server retry guidance, and survives
collector restarts. Each outbox is bounded at 10,000 events and drops its
oldest event if that limit is reached.

Inspect a bounded window of local Codex session history without sending data:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

The dry run counts request-level `last_token_usage` records and never sends prompts, transcripts, credentials, or usage
events. To upload the previous week:

```sh
npx @traice/collector@latest backfill codex --since 7d
```

When telemetry setup has recorded an activation time, an omitted `--until`
stops there so historical import does not cross the normal live-collection
boundary. Older configs fall back to the command start time. Replay uses stable
event IDs and paginated live-only reconciliation, so interrupted and repeated
uploads are idempotent even when the workspace already contains more than 500
rows.

## Browser authorization and credential storage

Interactive `setup` uses OAuth 2.0 device authorization. It prints a short code and a URL, attempts to open the URL,
and waits for approval. The URL can be opened on another device, so the same flow works over SSH:

```sh
npx @traice/collector@latest auth login --no-browser
npx @traice/collector@latest setup codex
```

Manage the saved session explicitly:

```sh
npx @traice/collector@latest auth login
npx @traice/collector@latest auth status
npx @traice/collector@latest auth logout
```

Access tokens are short-lived. The collector rotates its refresh credential automatically and stores the credential
bundle in the operating system credential manager:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service (for example GNOME Keyring or KWallet)

The non-secret collector config at `~/.traice/collector/config.json` contains only a credential reference. If an OS
credential manager is unavailable (common on headless Linux), the default `auto` mode falls back to
`~/.traice/collector/credentials.json` with user-only directory and file permissions (`0700`/`0600` on POSIX). The
installer reports this fallback explicitly; it is protected from other OS users but is not encrypted at rest.

Require native secure storage and fail instead of falling back:

```sh
npx @traice/collector@latest auth login --credential-store keyring
```

Force the protected-file backend for a headless or externally encrypted environment:

```sh
npx @traice/collector@latest auth login --credential-store file --no-browser
```

Workspace API keys remain supported for CI, containers, MDM, and other unattended automation. Read one from standard
input with `install --api-key-stdin`, or set `TRAICE_API_KEY` only in the collector process. The environment override
is not written to disk. Avoid `--api-key <value>` in a shared shell because it can be retained in shell history or
process inspection.

Existing configs containing a plaintext `apiKey` migrate automatically on the next `install` or `collect`.

## Connections, destinations, and routes

The collector runs one local service for all enabled coding agents. A connection is one signed-in trAIce account on
one server. Each authorized workspace is a destination. A route selects the destinations that receive one agent's
live usage.

```sh
npx @traice/collector@latest auth login --profile staging-a \
  --server-url https://staging.runtraice.com --workspace workspace-a
npx @traice/collector@latest auth login --profile production-z \
  --server-url https://www.runtraice.com --workspace workspace-z
npx @traice/collector@latest route set codex staging-a production-z
npx @traice/collector@latest destination list
npx @traice/collector@latest route list
```

The current config format calls each destination a profile for compatibility. Destinations have separate
workspace-scoped credentials, outboxes, retries, and deduplication boundaries. Routing changes are reloaded without
starting another collector or allocating another OTLP port. Use `route set claude-code ...` to give Claude Code a
different destination list.

The first destination in a route is authoritative for local admission. Every destination uses an isolated durable
outbox, so a backend or authorization failure for one workspace does not block the others. Failed delivery remains
queued and is retried in the background. Stable event IDs remain deduplicated independently inside each workspace.
Sending an event to two workspaces intentionally creates one row in each workspace. Without an explicit route, older
active-profile and mirror configuration remains the fallback.

Select a profile for a one-time status check or backfill:

```sh
npx @traice/collector@latest status --profile test-zoro
npx @traice/collector@latest backfill codex --profile test-zoro --since 1d
```

Legacy `profile use` and `profile mirror` commands remain supported. Revoke a destination with
`auth logout --profile <name>`.

## Updates

The background service uses an exact installed package version. It checks once per day and logs when a newer stable
release is available. Check or update it explicitly:

```sh
npx @traice/collector@latest update --check
npx @traice/collector@latest update
```

Updates install into a versioned runtime directory, rewrite the single service definition, and restart the service.

## CLI configuration and parameters

The short commands above use the production trAIce server, ask for identity and installation approval, install a
background service, and skip local history. Override those defaults only when needed:

| Option                        | Used by               | Purpose                                                            |
| ----------------------------- | --------------------- | ------------------------------------------------------------------ |
| `--server-url <url>`          | `auth login`, `setup` | Use another deployment together with an explicit named `--profile` |
| `--workspace <slug-or-id>`    | `auth login`, `setup` | Preselect a workspace on the browser authorization page            |
| `--profile <name>`            | Most commands         | Save, select, inspect, or backfill a named workspace profile       |
| `--mirror <name>`             | `collect`             | Add a one-run mirror override; repeat for multiple profiles        |
| `--employee-email <email>`    | `setup`               | Set the employee identity without the interactive question         |
| `--employee-name <name>`      | `setup`               | Set the optional employee display name                             |
| `--team-name <name>`          | `setup`               | Set the reporting team without the interactive question            |
| `--seat-monthly-usd <amount>` | `setup`               | Record an optional per-seat subscription commitment                |
| `--backfill-days <1-30>`      | `setup codex`         | Opt in to a bounded best-effort local history import               |
| `--no-backfill`               | `setup codex`         | Explicitly skip Codex history                                      |
| `--no-service`                | `setup`               | Configure without installing the background user service           |
| `--no-browser`                | `auth login`, `setup` | Print the authorization link for SSH or another device             |
| `--credential-store <mode>`   | `auth login`, `setup` | Select `auto`, `keyring`, or `file` credential storage             |
| `--yes`                       | `setup`               | Accept defaults in an explicitly configured unattended setup       |
| `--json`                      | Output commands       | Print machine-readable output instead of the human summary         |

Run `npx @traice/collector@latest help <command>` for the complete current option list.

Any process running as the same OS user can potentially ask an unlocked credential manager for saved credentials.
Keep the fallback file out of backups and profile sync. Revoke a browser-authorized device from `auth logout` or the
connected collectors list in trAIce.

## JavaScript

```js
const { normalizeClaudeCodeOtlpLogs } = require("@traice/collector");
```
