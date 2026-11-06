---
"@traice/sdk": minor
---

Shared semantic cache client. With `semanticCache.embeddingModel` set and a workspace opted in to trAIce's shared semantic cache, `CloudAdapter` looks up semantic-cache rules marked shared on trAIce after a local miss, sending only the request's embedding, the rule, the requested model and the embedding model name, never the request text. Lookups wait at most the advertised `timeoutMs` (300 ms) and fail open; new answers are stored in the background. A 403 or 409 turns sharing off until the next rules refresh. `getSemanticCacheStats()` adds `sharedHits`, `sharedLookupFailures`, and `sharedStores`, and shared hits are reported with `cacheStore: "shared"`.
