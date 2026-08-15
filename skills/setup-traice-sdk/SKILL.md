---
name: setup-traice-sdk
description: Install and integrate the trAIce product-runtime SDK into a TypeScript, JavaScript, Python, or HTTP application. Use when a user asks to track LLM tokens, cost, latency, features, users, tenants, workflows, or customer margin; configure @traice/sdk or traice-sdk; create the first product event; or safely obtain and store a trAIce workspace API key during onboarding.
---

# Set Up trAIce SDK

Instrument real product LLM calls with the smallest correct integration for the repository. Preserve provider return
values, errors, streaming behavior, and existing application semantics.

## 1. Inspect before editing

- Read repository instructions and current environment conventions.
- Find server-side LLM clients and their shared initialization or request boundary.
- Identify the runtime and package manager from lockfiles and manifests. Do not add a second package manager.
- Search for an existing `@traice/sdk`, `traice-sdk`, `TRAICE_API_KEY`, or `/api/v1/events` integration before adding
  another one.
- Identify existing customer, account, user, feature, workflow, run, and step identifiers. Never invent production
  identifiers.

Choose one integration:

- TypeScript or JavaScript: install `@traice/sdk` and use `configure`, `meter`, and lifecycle-appropriate `flush`.
- Python: install `traice-sdk` and use `configure`, `track`, and lifecycle-appropriate `flush`.
- Another runtime with an existing telemetry layer: use the HTTP event API.

Use the public guides for runtime-specific and streaming details:

- https://www.runtraice.com/docs/sdk-quickstart
- https://www.runtraice.com/docs/typescript-sdk
- https://www.runtraice.com/docs/python-sdk
- https://www.runtraice.com/docs/http-api

## 2. Obtain the workspace credential safely

If `TRAICE_API_KEY` is already available through the process environment, a local ignored environment file, or the
deployment secret manager, use the variable name without reading or printing its value.

If it is absent:

1. Open this URL for the user:

   https://www.runtraice.com/login?callbackUrl=%2Fapp%2Fapi-keys

   First sign-in creates the account and first workspace, then returns to API keys.
   Over SSH or on a headless machine, show the plain URL so the user can open it in any browser.

2. Ask the user to create a workspace key named for the service and environment.
3. For a local ignored environment file, run the bundled helper from the repository root. Pass an absolute helper path
   when necessary:

   ```sh
   node PATH_TO_SKILL/scripts/store-api-key.mjs --target .env.local
   ```

   The helper reads the key with hidden terminal input, refuses tracked or non-ignored files, and never prints the
   secret. For CI or hosting, use that platform's secret manager instead of writing a file.

4. Wait for the user to finish secret entry. Do not accept the key in chat and do not put it in a shell command.

Use the application's established environment file when one exists. Prefer `.env.local` for Next.js. Do not assume a
generic Python process loads `.env`; use its existing configuration system.

## 3. Integrate the runtime

- Configure cloud delivery once in a server-only process boundary using `process.env.TRAICE_API_KEY` or
  `os.environ["TRAICE_API_KEY"]`.
- Wrap actual provider calls at the narrowest shared boundary. Do not replace the provider client or alter retries,
  streaming, exceptions, or response types.
- Populate `tenantId` from the customer or account the product bills. Populate `userId`, `feature`, `workflowId`,
  `runId`, `stepId`, `agentId`, and `toolName` only when the application already has those values.
- Flush short-lived scripts, jobs, and serverless paths before exit. Long-running services should use the SDK's normal
  batching and shutdown lifecycle.
- Keep trAIce delivery fail-open unless the user explicitly asks to enforce a budget or policy.

## 4. Verify

1. Run the repository's focused tests, type checks, lint, and build checks appropriate to the touched path.
2. Confirm no raw key or `lm_live_` value appears in tracked changes or command output.
3. Confirm the integration runs only on the server and does not bundle the key into browser code.
4. Exercise an existing safe application path when available. Do not invent or send a synthetic customer event
   without user approval.
5. Tell the user how to trigger one real event and where to confirm it in the trAIce dashboard.

## Final response

Report the runtime and integration point, package and files changed, checks run, credential location by type only
(environment file, OS store, or deployment secret manager), and any attribution field the application could not
safely supply.
