---
title: Collector Configuration
excerpt: Manage collector destinations, credentials, identity, local state, and compatibility safely.
section: Internal spend
sectionOrder: 3
order: 2
---

# Collector Configuration

The collector keeps non-secret device configuration in:

```text
~/.traice/collector/config.json
```

Prefer the collector CLI over editing this file. CLI commands validate destination names and folder paths, retain a
backup before writes, and refresh an outdated installed service when required.

## Inspect the current configuration

Use read-only commands for routine inspection:

```bash
npx @traice/collector@latest status
npx @traice/collector@latest destination list
npx @traice/collector@latest route list
```

Add `--json` when another tool needs structured output. Review output before sharing it because summaries can contain
local paths, workspace details, and signed-in account details.

## Configuration model

| Setting                    | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `destinations`             | Authorized workspaces, server URLs, and credential references     |
| `routes`                   | Default destinations for each supported coding agent              |
| `folderRoutes`             | Optional local folder rules for repository-aware routing          |
| `enabledAgents`            | Codex and Claude Code adapters managed by the collector           |
| `identity`                 | Employee and team attribution                                     |
| `sources`                  | Stable source identity for each agent                             |
| `listenHost`, `listenPort` | Loopback listener address and port                                |
| `includePrompts`           | Prompt capture setting, disabled by default                       |
| `telemetryEnabledAt`       | First live telemetry activation time used to bound Codex backfill |

The exported [`CollectorConfig`](https://github.com/runtraice/traice-sdk/blob/main/packages/collector/src/types.ts)
type is the public schema reference. Unknown manual edits can make the collector fail closed at startup, so use
`setup`, `auth`, `route`, and `context` commands for supported changes.

Most commands accept `--config <path>` for testing or externally managed collector instances. A background service
installed by normal setup uses the default path.

## Destinations and credentials

A destination is one authorized trAIce workspace. Add, inspect, or remove destinations with:

```bash
npx @traice/collector@latest auth login --destination engineering --workspace engineering
npx @traice/collector@latest auth status --destination engineering
npx @traice/collector@latest auth logout --destination engineering
```

Renewable OAuth credentials are stored separately from `config.json` in macOS Keychain, Windows Credential Manager,
or Linux Secret Service. When a native store is unavailable, `auto` mode uses a user-only protected file and reports
the fallback. Use `--credential-store keyring` to require the native store.

For unattended automation, pass an API key through standard input:

```bash
printf '%s\n' "$TRAICE_API_KEY" |
  npx @traice/collector@latest install codex \
    --destination ci \
    --api-key-stdin \
    --patch-settings
```

Do not pass credentials directly on shared command lines or commit collector state.

## Compatibility and backups

Current configuration uses schema version 2. Existing configurations continue to work without manual migration:

- Version 1 configuration is migrated in memory when read.
- Read-only commands do not rewrite an older configuration under a pinned older service.
- The next explicit configuration change writes the current schema and first retains the previous file.
- Missing optional fields, including `folderRoutes`, preserve existing per-agent and single-destination behavior.

The CLI keeps up to 20 bounded backups in `~/.traice/collector/backups/`. Use `status` after an upgrade or
configuration change. It reports configuration validity, CLI and service version alignment, listener health,
credentials, and server access for every routed destination.

## Local data boundary

Folder routes store canonical local paths in `config.json`, but those paths are used only for local route selection.
They are never added to uploaded telemetry. Credentials also remain outside event payloads. Prompt and output capture
is off by default.

See [Collector Routing](/docs/collector-routing) for route behavior and [Privacy](/docs/privacy) for the complete event
allowlist.
