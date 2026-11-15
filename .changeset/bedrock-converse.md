---
"@traice/sdk": minor
---

Support Amazon Bedrock. `meter()` recognizes a Converse response as provider `aws-bedrock` and counts cache reads and writes in the input. The new `CloudAdapter.enforceBedrockRequest()` runs a request that names its model as `modelId` through active rules, and rewrites `modelId` for swaps, rollouts, and fallbacks. Decisions now report the cost basis of the model that was served when a response does not name its model.
