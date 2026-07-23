---
"@traice/sdk": minor
"@traice/collector": minor
"@traice/protocol": patch
---

Harden telemetry delivery with stable event identities, bounded retry and
timeout behavior, delivery health counters, privacy-safe content defaults, and
optional restart-safe SDK storage.

Accept collector telemetry into a bounded durable outbox before responding to
local agents, drain it asynchronously in strict batches, and expose queue
health. Add internal-event latency to the public protocol.
