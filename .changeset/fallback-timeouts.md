---
"@traice/sdk": minor
---

Fallback rules can bound and retry the original call. A rule's `timeoutMs` gives each call a deadline, `retryOn` (`timeout`, `429`, `5xx`, or `error`) chooses which failures lead to a retry or the fallback, and `maxRetries` with `backoffMs` retries the original model with jittered exponential backoff before falling back. `enforceRequest` and `enforceBedrockRequest` pass `{ signal }` to the provider callback as an optional second argument so a call past its deadline can be aborted. Fallback decisions now report `errorType`, `fallbackLatencyMs`, and the number of attempts. Rules without these parameters behave as before.
