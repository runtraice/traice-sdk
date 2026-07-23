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

The TypeScript and Python product SDKs also omit prompt and output samples by
default. Enable `captureContent` or `capture_content` only after reviewing data
classification, retention, and access controls. Durable local queues can
contain event metadata and must use user-only file permissions.

## Product usage importers

The LiteLLM and Langfuse import commands read vendor credentials from environment variables and keep them in the local process. They send only normalized usage, cost, attribution, and a small allowlist of operational metadata to trAIce.

The Langfuse importer does not request observation input or output fields. Both importers exclude arbitrary vendor metadata and known credential fields. Store vendor credentials in your operating system credential store or another secret manager and inject them only for the import process.
