# @traice/collector

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
