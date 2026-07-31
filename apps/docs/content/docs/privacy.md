---
title: Privacy
excerpt: What collectors send, what they avoid, and how prompt capture is controlled.
section: Internal spend
sectionOrder: 3
order: 4
---

# Privacy

Collectors send usage metadata needed for Internal Spend:

- Source and tool identifiers.
- Employee, team, and source-principal mapping.
- Provider and model when present.
- Run, step, and source event identifiers.
- Token counts, cost basis, status, and redacted metadata.

Collectors do not send prompts or model outputs by default.

Collector metadata uses an explicit operational allowlist. Secret, token,
cookie, password, authorization, and unrecognized OTLP attributes are not
forwarded. The raw OTLP log body is excluded unless prompt capture is enabled.

Use `--include-prompts` only when the organization explicitly approves prompt logging.

## Manual task context

Destination-scoped task context is also opt-in. The collector sends a description, repository label, role,
department, or custom labels only after the user runs `context set`. Repository inference reads the local Git remote
only when `--repository auto` is supplied.

Manual descriptions are capped at 280 characters. Custom labels must be a JSON object and are capped at 24 keys,
three nesting levels, 2 KiB, 256 characters per string, and 20 items per array. The complete context is capped at
4 KiB. Secret-looking keys and values are redacted before storage. `context clear` stops attaching task context to new
events.

The TypeScript and Python product SDKs also omit prompt and output samples by
default. Enable `captureContent` or `capture_content` only after reviewing data
classification, retention, and access controls. Durable local queues can
contain event metadata and must use user-only file permissions.

When the TypeScript SDK receives a local `prompt`, its cloud adapter can send a
versioned HMAC for exact duplicate analysis without sending the prompt itself.
The API key scopes the fingerprint to that credential. Semantic shadow analysis
uses only the embedding function configured by the application and reports a
similarity score plus token cost basis, not request text or embedding vectors.

## Product usage importers

The LiteLLM and Langfuse import commands read vendor credentials from environment variables and keep them in the local process. They send only normalized usage, cost, attribution, and a small allowlist of operational metadata to trAIce.

The Langfuse importer does not request observation input or output fields. Both importers exclude arbitrary vendor metadata and known credential fields. Store vendor credentials in your operating system credential store or another secret manager and inject them only for the import process.
