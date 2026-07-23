# @traice/protocol

## 0.1.3

### Patch Changes

- 69bb5ea: Harden telemetry delivery with stable event identities, bounded retry and
  timeout behavior, delivery health counters, privacy-safe content defaults, and
  optional restart-safe SDK storage.

  Accept collector telemetry into a bounded durable outbox before responding to
  local agents, drain it asynchronously in strict batches, and expose queue
  health. Add internal-event latency to the public protocol.

## 0.1.2

### Patch Changes

- d7eea3c: Allow Codex backfill to snapshot its upper boundary at command start, and carry optional monthly seat commitments with internal usage events.

## 0.1.1

### Patch Changes

- b035890: Build package artifacts during packing and verify every publishable tarball in
  CI so fresh release runners include declared entry points and command binaries.
