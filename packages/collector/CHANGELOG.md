# @traice/collector

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
