---
title: Codex
excerpt: Configure Codex telemetry for trAIce Internal Spend.
section: Internal spend
sectionOrder: 3
order: 3
---

# Codex

Run interactive setup:

```sh
npx @traice/collector@latest setup
```

Choose Codex when prompted. Setup starts browser authorization when needed, patches the user-level
`~/.codex/config.toml`, configures routes, and installs a background user service. It is safe to rerun. The managed
OTel block is updated in place and is not duplicated.

Restart every running Codex session afterward. Codex reads OTel configuration when a session starts, so existing
sessions will not begin exporting live usage.

To preselect Codex while keeping confirmation interactive:

```sh
npx @traice/collector@latest setup --agent codex
```

For SSH, add `--no-browser` and open the printed authorization URL on any device.

## Multiple workspaces

The browser authorization page can select multiple workspaces. Each receives a separate destination and scoped
credential. Route Codex to one or more destinations:

```sh
npx @traice/collector@latest destination list
npx @traice/collector@latest route set codex live-demo sandbox
npx @traice/collector@latest route list
```

`route list` shows each destination's workspace, signed-in account, and server. The existing service reloads route
changes. Each destination has an isolated credential, durable outbox, retry state, and server-side deduplication
boundary.

## Windows setup

Run as the Windows user whose Codex usage should be collected. Administrator access is not required.

```bat
npx @traice/collector@latest setup
```

The browser session is stored in Windows Credential Manager and a hidden per-user Startup launcher keeps the
collector running. If `npx` is unavailable, install Node.js LTS, reopen the terminal, and retry:

```bat
winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
```

## Optional history backfill

Live collection does not replay old sessions automatically. Local JSONL history can contain gaps, so treat backfill
as a best-effort supplement.

Inspect a bounded window:

```sh
npx @traice/collector@latest backfill codex --since 14d --dry-run
```

Upload the previous week:

```sh
npx @traice/collector@latest backfill codex --destination live-demo --since 7d
```

You can also offer backfill during setup:

```sh
npx @traice/collector@latest setup --agent codex --backfill-days 7
```

The user must approve the import. When telemetry activation time is known, an omitted `--until` stops there so history
does not cross the live collection boundary. Stable event IDs and paginated live reconciliation make repeated uploads
idempotent.

## Background service

Setup installs and starts one user service:

- macOS: `launchd` with `RunAtLoad` and `KeepAlive`
- Linux: `systemd --user`
- Windows: a hidden per-user Startup launcher

The service uses a persistent package runtime rather than an `npx` cache. Credentials remain outside the service
definition and are resolved through references in `~/.traice/collector/config.json`. Run `status` to verify the pinned
service version, listener, and every routed destination. Destination and route changes refresh an outdated installed
service automatically.
