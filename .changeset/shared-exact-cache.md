---
"@traice/sdk": minor
---

Share exact-cache answers across instances. When a workspace opts in to trAIce's shared response cache and an exact-cache rule is marked shared, `CloudAdapter` checks trAIce after a local miss and stores new answers in the background. The request never leaves the process: lookups send only an HMAC key (protocol `shared-exact-v1`, matching `@traice/enforce`). Lookups wait at most 150 ms and fail open; a refusal from trAIce turns the shared cache off until the next rules refresh. `getExactCacheStats()` adds `sharedHits`, `sharedLookupFailures` and `sharedStores`.
