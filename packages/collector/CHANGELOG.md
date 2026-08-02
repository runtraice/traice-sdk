# @traice/collector

## 0.8.0

### Minor Changes

- fc69773: Add local repository benchmark manifests, A/B stage and task recording, comparison output, private draft upload, and
  the `benchmarks:write` collector authorization scope.
- 2e6ec88: Add opt-in, destination-scoped employee attribution and bounded manual task context with CLI management. Accept local application usage through the collector's machine-local loopback endpoint so one collector can route it to configured destinations.

## 0.7.3

### Patch Changes

- 946fa11: Keep the local listener running and queue usage when any routed destination authorization is unavailable during startup.

## 0.7.2

### Patch Changes

- 376aba8: Check every unique routed destination in collector status, report destination-specific credential and server health, and retain `--destination` for focused diagnostics.

## 0.7.1

### Patch Changes

- f837639: Keep legacy config reads side-effect free, detect a pinned service version mismatch in status, and refresh an outdated installed service after destination, authorization, route, or advanced install changes.

## 0.7.0

### Minor Changes

- d56fb6c: Replace collector profiles and mirrors with workspace destinations and per-agent routes, add a readable routing map and multi-workspace device authorization support, default new logins to production, and provide one interactive setup command that detects supported agents.

## 0.6.0

### Minor Changes

- 6226a5e: Run Codex and Claude Code through one source-aware service, infer known providers, add per-agent destination routes,
  use human-readable command output by default, and add stable collector update checks and installation.

## 0.5.0

### Minor Changes

- 5c58e63: Make Codex history backfill opt-in, require interactive setup approval by default, keep no-argument authorization on production, and print service, status, and coding-agent restart guidance after setup.

## 0.4.0

### Minor Changes

- a989571: Add named workspace profiles, explicit live mirrors with isolated durable delivery, profile-specific status and backfill,
  and separate credential storage. Codex setup now merges an existing `[otel]` table and repairs collector-created
  duplicates instead of appending an invalid second table.
- 69bb5ea: Harden telemetry delivery with stable event identities, bounded retry and
  timeout behavior, delivery health counters, privacy-safe content defaults, and
  optional restart-safe SDK storage.

  Accept collector telemetry into a bounded durable outbox before responding to
  local agents, drain it asynchronously in strict batches, and expose queue
  health. Add internal-event latency to the public protocol.

### Patch Changes

- Updated dependencies [69bb5ea]
  - @traice/protocol@0.1.3

## 0.3.1

### Patch Changes

- fa80f98: Use browser authorization when a saved API key is rejected, and authorize a changed server before presenting any saved credential.

## 0.3.0

### Minor Changes

- d3dac93: Add OAuth 2.0 device authorization for interactive collector setup, including secure token storage, automatic refresh,
  SSH-friendly login, status and logout commands, and API-key compatibility for unattended automation.

## 0.2.9

### Patch Changes

- 2129c65: Improve Windows setup with Command Prompt support, masked API-key paste feedback, actionable key diagnostics, clearer identity prompts, and an administrator-free per-user startup launcher. Use the canonical trAIce host so authorization is preserved instead of being lost during a cross-origin redirect.

## 0.2.8

### Patch Changes

- da4c582: Confirm employee and team identity during first-run setup, with Git email comparison and automation-safe defaults.

## 0.2.7

### Patch Changes

- 3ccb8bb: Add secure collector status checks, machine-readable output, explicit help examples, and safer CLI failure handling.

## 0.2.6

### Patch Changes

- 4a73838: Add one-command collector setup with credential reuse, connection verification, background service installation, and configurable Codex backfill.

## 0.2.5

### Patch Changes

- d7eea3c: Allow Codex backfill to snapshot its upper boundary at command start, and carry optional monthly seat commitments with internal usage events.
- Updated dependencies [d7eea3c]
  - @traice/protocol@0.1.2

## 0.2.4

### Patch Changes

- f331b37: Report the installed collector version from package metadata and refresh SDK, CLI, dashboard, and documentation copy.

## 0.2.3

### Patch Changes

- 311d902: Enable bounded Codex history uploads with stable replay IDs, live-event overlap checks, and batch progress. Prefer the
  real Codex `event.timestamp` when OTLP exports a zero transport timestamp.

## 0.2.2

### Patch Changes

- 4ee619d: Normalize token attributes emitted by current Codex OTLP log events.

## 0.2.1

### Patch Changes

- 2ca521f: Generate Codex-compatible OTLP HTTP configuration and add a bounded, read-only Codex history backfill dry run.

## 0.2.0

### Minor Changes

- 3b7ea9f: Store collector API keys in macOS Keychain, Windows Credential Manager, or Linux Secret Service, with explicit strict
  and protected-file modes plus automatic migration away from plaintext config.

## 0.1.2

### Patch Changes

- b990422: Serialize downstream forwarding, use smaller batches, and retry transient ingest failures with exponential backoff.

## 0.1.1

### Patch Changes

- b035890: Build package artifacts during packing and verify every publishable tarball in
  CI so fresh release runners include declared entry points and command binaries.
- Updated dependencies [b035890]
  - @traice/protocol@0.1.1
