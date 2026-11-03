---
"@traice/sdk": minor
---

Send the full request for replay. `meter()`, `CostMeter.track()` and `record()` accept a `request` option with OpenAI Chat Completions, Anthropic Messages, or Bedrock Converse parameters. The new `captureRequest()` reduces it to the system prompt, the user and assistant turns, and the sampling parameters, and drops requests with tool calls, images, or other non-text parts. Cloud delivery sends it only when content capture is on.
