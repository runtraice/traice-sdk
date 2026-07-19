# @traice/collector

Unified local collector for coding-agent usage.

## Claude Code

```sh
npx @traice/collector@latest setup claude-code \
  --server-url https://www.runtraice.com \
  --employee-email you@company.com \
  --employee-name "Your Name" \
  --team-name Engineering
```

`setup` prompts for the API key only when a valid saved credential is unavailable, patches the agent settings, and
installs a background user service. It is safe to rerun.

Prompt logging stays disabled unless you explicitly pass `--include-prompts`.

## Codex

```sh
npx @traice/collector@latest setup codex \
  --server-url https://www.runtraice.com \
  --employee-email you@company.com \
  --team-name Engineering \
  --backfill-days 7
```

Codex setup backfills the previous 7 days by default. Set `--backfill-days` from 1 to 30, use `--no-backfill` to skip
history, or use `--no-service` when another process manager will run the collector.

The maintained collector forwards live OTLP telemetry only; it does not scan
or replay an unbounded history of local session files. Stop any legacy Codex
collector process before starting `@traice/collector`.

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

## API key storage

`setup` and `install` store the API key in the operating system credential manager by default:

- macOS Keychain
- Windows Credential Manager
- Linux Secret Service (for example GNOME Keyring or KWallet)

The non-secret collector config at `~/.traice/collector/config.json` contains only a credential reference. If an OS
credential manager is unavailable (common on headless Linux), the default `auto` mode falls back to
`~/.traice/collector/credentials.json` with user-only directory and file permissions (`0700`/`0600` on POSIX). The
installer reports this fallback explicitly; it is protected from other OS users but is not encrypted at rest.

Require native secure storage and fail instead of falling back:

```sh
npx @traice/collector@latest install codex --api-key-stdin --credential-store keyring
```

Force the protected-file backend for a headless or externally encrypted environment:

```sh
npx @traice/collector@latest install codex --api-key-stdin --credential-store file
```

Existing configs containing a plaintext `apiKey` migrate automatically on the next `install` or `collect`. For CI,
containers, MDM, or an external secret manager, set `TRAICE_API_KEY` only in the collector process; `collect` uses that
value without writing it to disk.

The API key remains a bearer credential: a process running as the same OS user can ask the unlocked credential manager
for it. Use a dedicated, revocable collector key and avoid copying the fallback file into backups or profile sync.

## JavaScript

```js
const { normalizeClaudeCodeOtlpLogs } = require("@traice/collector");
```
