# @traice/sdk Changelog

## 0.7.1

### Patch Changes

- b3c148f: Retain explicitly requested model identifiers when failed or nonstandard responses do not report a model. Add current GPT-5.4 through GPT-5.6 pricing and model-specific cache rates.

## 0.7.0

### Minor Changes

- 5321e9a: Add opt-in process-local semantic-cache execution and evidence-gated, explicitly allowlisted route execution to the cloud enforcement wrapper.

## 0.6.0

### Minor Changes

- 820e437: Add a typed portable enforcement-policy export API and `traice policy export` command for custom wrappers and gateway adapters.

## 0.5.0

### Minor Changes

- 9009bfc: Add retry-safe LiteLLM spend-log and Langfuse observation import helpers plus `traice import` CLI commands with bounded backfills and dry runs.

## 0.4.5

### Patch Changes

- e919ad1: Add two-step confirmed Ask trAIce actions to the TypeScript client and CLI for budgets, alert snoozes, and evidence-gated shadow guardrails.

## 0.4.4

### Patch Changes

- e8cb483: Add fail-open workspace budget advice with cached downgrade and block helpers plus policy health telemetry.

## 0.4.3

### Patch Changes

- 959bcb3: Require experiment-derived model rules to match the exact validated source model before enforcement.

## 0.4.2

### Patch Changes

- 470beaf: Add workspace kill-switch support, cached budget conditions, user-scoped enforcement context, and observable fail-open control-plane metrics for request-path enforcement.

## 0.4.1

### Patch Changes

- 4f86186: Support explicit provider identifiers and normalized AI SDK token usage in `meter()`.

## 0.4.0

### Minor Changes

- c6f7dab: Add opt-in request-path execution for active exact-cache, deny, retry-cap, evidence-gated swap or downgrade, and one-shot fallback rules with structured blocking errors and fail-open rule evaluation.

## 0.3.1

### Patch Changes

- Verify npm release automation and linked Slack release notifications.

## 0.3.0

### Minor Changes

- 002a0d1: Add the `traice ask` command, cross-platform secure credential storage, the read-only ask API client, and MCP client setup documentation.
- 77dc155: Export the pure enforcement decision core and use it for active exact-cache rule selection.

## 0.2.5

### Patch Changes

- 584eb56: Document the bundled CLI version command and verify the reviewed npm OIDC release notification flow.

## 0.2.4

### Patch Changes

- f331b37: Report the installed collector version from package metadata and refresh SDK, CLI, dashboard, and documentation copy.

## 0.2.3

### Patch Changes

- 44a55f6: Report the package version from the SDK CLI instead of a stale hard-coded value.

## 0.2.2

### Patch Changes

- f086445: Clarify that the SDK package includes the command-line interface.

## 0.2.1

### Patch Changes

- b035890: Build package artifacts during packing and verify every publishable tarball in
  CI so fresh release runners include declared entry points and command binaries.

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
