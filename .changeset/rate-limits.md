---
"@traice/sdk": minor
---

Rate limits (enforcement protocol v3). `CloudAdapter` now polls rules with `X-Traice-Enforcement-Version: 3` and receives `RATE_LIMIT` rules, which cap requests and/or tokens per minute for the whole workspace, each API key, or each end user (`userId` in the request context). Before a matching call, the SDK asks trAIce to count it, so a limit holds across every instance; it waits at most the advertised `timeoutMs` (150 ms) and lets the call through if trAIce does not answer. A refusal throws `TraiceEnforcementError` with action `RATE_LIMIT` and `retryAfterMs`, and the SDK refuses locally for that rule until the retry time passes. Calls matched by a tokens-per-minute rule report their tokens in the background. `decide()` skips rate-limit rules and the new `matchRateLimitRules()` returns them, so a limit never hides a later rule. `getRateLimitStats()` reports acquired, refused, locally refused, would-have-refused and fail-open counts.
