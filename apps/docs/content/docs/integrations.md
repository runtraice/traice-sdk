---
title: OpenTelemetry and Vendor Imports
excerpt: Send OTel GenAI spans or backfill normalized LiteLLM and Langfuse cost data without copying prompts or responses.
section: Product SDKs
sectionOrder: 2
order: 5
---

# OpenTelemetry and Vendor Imports

Use an existing telemetry or gateway source when it already has authoritative model usage. OpenTelemetry can stream new GenAI spans directly. The CLI can backfill LiteLLM spend logs or Langfuse generation observations.

All three paths use stable source identities. Retrying the same span, spend log, or observation returns success without creating another event, consuming monthly event quota, or repeating rollups and guardrail evaluation.

## OpenTelemetry GenAI

Create a workspace API key and configure an OTLP trace exporter for HTTP/JSON:

```sh
export TRAICE_API_KEY='<workspace-api-key>'
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT='https://www.runtraice.com/api/v1/otel/v1/traces'
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL='http/json'
export OTEL_EXPORTER_OTLP_TRACES_HEADERS="authorization=Bearer%20${TRAICE_API_KEY}"
```

The beta receiver accepts `application/json`. OTLP protobuf and gRPC are not supported yet. Set the exporter batch size at or below the workspace ingest limit: 100 spans on Free, 250 on Starter, and 500 on Pro or Team.

The receiver maps current GenAI attributes and common legacy names. Add optional `traice.feature`, `traice.user_id`, `traice.tenant_id`, `traice.agent_id`, `traice.workflow_id`, `traice.run_id`, `traice.step_id`, `traice.tool_name`, `traice.retry_count`, and `traice.outcome` resource or span attributes for business attribution.

trAIce does not retain complete traces, span names, prompt bodies, or completion bodies through this endpoint.

## Save the trAIce credential

Install the CLI and save the workspace API key in the operating system credential manager:

```sh
npm install --global @traice/sdk
export TRAICE_API_KEY='<workspace-api-key>'
traice auth login
unset TRAICE_API_KEY
```

The CLI uses macOS Keychain, Windows Credential Manager, or the available Linux secret service. If the native store is unavailable, it reports the fallback and uses a user-only protected file.

## Import LiteLLM spend logs

The importer reads LiteLLM `/spend/logs` with `summarize=false` in bounded date windows. Keep the LiteLLM credential in the current process environment:

```sh
export LITELLM_BASE_URL='https://litellm.example.com'
export LITELLM_MASTER_KEY='<litellm-admin-or-spend-reader-key>'

traice import litellm --since 7d --dry-run
traice import litellm --since 30d

unset LITELLM_MASTER_KEY
```

You can use `LITELLM_API_KEY` instead of `LITELLM_MASTER_KEY` when that key has access to spend routes. Use `--until <ISO-date>` to fix an upper boundary and `--json` for machine-readable totals.

Event identity is namespaced by the source base URL. If the deployment URL may change, pass a durable label such as `--source-key production-gateway` on every run.

The mapper sends request identity, time, model/provider, tokens, cost, latency, selected team/user/tenant fields, and explicitly named trAIce attribution. It never copies the LiteLLM key or arbitrary spend-log metadata.

## Import Langfuse observations

The importer uses the Langfuse v2 Observations API with bounded windows, cursor pagination, and generation-only rows. It deliberately omits the `io` field group:

```sh
export LANGFUSE_PUBLIC_KEY='<langfuse-public-key>'
export LANGFUSE_SECRET_KEY='<langfuse-secret-key>'

traice import langfuse --since 7d --dry-run
traice import langfuse --since 30d

unset LANGFUSE_SECRET_KEY
```

Set `LANGFUSE_BASE_URL` or pass `--base-url` for a regional or self-hosted deployment. The mapper keeps usage, cost, timing, model, trace identity, selected business fields, and safe integration labels. It does not request or send Langfuse input/output fields.

Use `--source-key` when you need a durable identity independent of the Langfuse base URL.

## Operational behavior

- The default backfill is seven days. Durations accept hours, days, or weeks, such as `24h`, `7d`, and `4w`.
- Imports stream bounded vendor pages into trAIce batches of 50 instead of retaining the whole backfill in memory.
- Retryable rate-limit and temporary gateway responses use bounded retries. Existing stable event identities make upload retries safe.
- `--dry-run` fetches and maps records but does not write product events.
- Vendor credentials stay in the local process. trAIce receives only the normalized event and its workspace API key.

## Export policy to a gateway or custom wrapper

Export the workspace's current user-authored enforcement policy as portable JSON:

```sh
traice policy export --output traice-policy.json
```

The bundle contains active and shadow rules, current experiment evidence, and budget utilization snapshots. It contains no API keys. The command refuses to overwrite an existing file unless you pass `--force`.

This is a versioned trAIce policy bundle for gateway adapters and custom wrappers. It is not generated LiteLLM YAML: budget predicates, evidence gates, and decision-record semantics cannot be represented safely as a static LiteLLM configuration. An adapter must preserve those semantics and fail open when it cannot evaluate them.

## Related pages

- [Install Guide](/docs/install)
- [HTTP and cURL](/docs/http-api)
- [Event contract reference](/docs/event-reference)
- [Privacy and data handling](/docs/privacy)
