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

Metadata is redacted for keys that look like secrets, tokens, cookies, passwords, or authorization values. Prompt-like attribute keys are dropped from normalized telemetry metadata.

Use `--include-prompts` only when the organization explicitly approves prompt logging.
