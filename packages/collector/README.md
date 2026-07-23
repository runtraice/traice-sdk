# @traice/collector

Unified local collector for coding-agent usage.

## Claude Code

```sh
npx --yes @traice/collector@latest auth login
npx --yes @traice/collector@latest setup claude-code
```

Authorize the device in your browser, then run `setup` to patch the agent settings and install a background user
service. You can also run `setup` directly; it starts browser authorization when a valid saved session is unavailable.
You do not need to copy an API key. Both commands are safe to rerun.

On the first interactive run, setup compares the requested employee email with the local Git email and asks which
identity to use. It also confirms a standard team name so reporting does not split across spelling variants. Use
`--yes` with explicit flags for unattended installation.

Prompt logging stays disabled unless you explicitly pass `--include-prompts`.

## Codex

```sh
npx --yes @traice/collector@latest auth login
npx --yes @traice/collector@latest setup codex
```

Codex setup backfills the previous 7 days by default. Set `--backfill-days` from 1 to 30, use `--no-backfill` to skip
history, or use `--no-service` when another process manager will run the collector.

### Windows

Run these commands one at a time in Command Prompt:

```bat
npx --yes @traice/collector@latest auth login
npx --yes @traice/collector@latest setup codex
```

Run the same two commands one at a time in PowerShell:

```powershell
npx --yes @traice/collector@latest auth login
npx --yes @traice/collector@latest setup codex
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

Live telemetry is durably queued in
`~/.traice/collector/state/outbox.ndjson` before the local listener returns
HTTP 202. Backend delivery runs asynchronously in batches, honors server retry
guidance, and survives collector restarts. The outbox is bounded at 10,000
events and drops the oldest event if that limit is reached.

Inspect a bounded window of local Codex session history without sending data:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

The dry run counts request-level `last_token_usage` records and never sends prompts, transcripts, credentials, or usage
events. To upload the previous week through the time the command starts:

```sh
npx @traice/collector@latest backfill codex --since 7d
```

The collector snapshots an omitted `--until` boundary to the command start time. Replay uses stable event IDs so
retries are idempotent and checks existing live usage in
the bounded window to skip cross-mode duplicates. If the live overlap is too large to audit completely, it refuses
the replay and asks for an earlier cutoff.

## Browser authorization and credential storage

Interactive `setup` uses OAuth 2.0 device authorization. It prints a short code and a URL, attempts to open the URL,
and waits for approval. The URL can be opened on another device, so the same flow works over SSH:

```sh
npx --yes @traice/collector@latest auth login --no-browser
npx --yes @traice/collector@latest setup codex
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

## CLI configuration and parameters

The short commands above use the production trAIce server, ask for missing identity choices, install a background
service, and backfill 7 days of Codex history. Override those defaults only when needed:

| Option                        | Used by               | Purpose                                                                  |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `--server-url <url>`          | `auth login`, `setup` | Use another trAIce deployment, such as staging or a self-hosted instance |
| `--workspace <slug-or-id>`    | `auth login`, `setup` | Preselect a workspace on the browser authorization page                  |
| `--employee-email <email>`    | `setup`               | Set the employee identity without the interactive question               |
| `--employee-name <name>`      | `setup`               | Set the optional employee display name                                   |
| `--team-name <name>`          | `setup`               | Set the reporting team without the interactive question                  |
| `--seat-monthly-usd <amount>` | `setup`               | Record an optional per-seat subscription commitment                      |
| `--backfill-days <1-30>`      | `setup codex`         | Change the default 7-day history window                                  |
| `--no-backfill`               | `setup codex`         | Skip Codex history                                                       |
| `--no-service`                | `setup`               | Configure without installing the background user service                 |
| `--no-browser`                | `auth login`, `setup` | Print the authorization link for SSH or another device                   |
| `--credential-store <mode>`   | `auth login`, `setup` | Select `auto`, `keyring`, or `file` credential storage                   |
| `--yes`                       | `setup`               | Accept defaults in an explicitly configured unattended setup             |

Run `npx @traice/collector@latest help <command>` for the complete current option list.

Any process running as the same OS user can potentially ask an unlocked credential manager for saved credentials.
Keep the fallback file out of backups and profile sync. Revoke a browser-authorized device from `auth logout` or the
connected collectors list in trAIce.

## JavaScript

```js
const { normalizeClaudeCodeOtlpLogs } = require("@traice/collector");
```
