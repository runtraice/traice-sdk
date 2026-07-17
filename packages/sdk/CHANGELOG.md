# @traice/sdk Changelog

## 0.2.0

### Minor Changes

- b2ac4ed: Add active exact-cache guardrails, safe streaming bypass, OpenAI Responses API
  savings calculation, and process-local cache metrics.

## Unreleased

- Add opt-in active exact-cache guardrails with deterministic request hashing,
  bounded process-local storage, bypass controls, Decision Records, and local
  hit-rate/savings metrics.
- Pass streaming requests through safely and correctly price OpenAI Responses
  API cache savings.

## 0.1.0

- Initial scoped public release under `@traice/sdk`.
- Supports TypeScript declarations and JavaScript consumers through ESM and CommonJS exports.
- Includes console, local file, cloud, webhook, and OpenTelemetry adapters.
