---
name: setup-traice
description: Set up trAIce end to end for a software repository and the developer's local coding agents. Use when a user asks to install, configure, onboard, or connect trAIce; wants product LLM cost attribution; wants Codex or Claude Code usage collection; or asks for the fastest complete trAIce setup without knowing which integration they need.
---

# Set Up trAIce

Configure the integrations that match the repository and machine, verify them, and leave secrets out of chat, logs,
commits, and command arguments.

## Workflow

1. Read the repository instructions and preserve unrelated work.
2. Inspect the project for server-side LLM calls, TypeScript or Python runtimes, existing trAIce configuration, and
   installed Codex or Claude Code clients.
3. Choose the required paths:
   - Product code calls an LLM for customers or end users: use `$setup-traice-sdk`.
   - Codex or Claude Code runs on this machine: use `$setup-traice-collector`.
   - Both are present: run both skills. Product and employee usage are separate data flows.
4. If a focused skill is not installed, install all public setup skills from the SDK repository:

   ```sh
   npx skills add runtraice/traice-sdk \
     --skill setup-traice \
     --skill setup-traice-sdk \
     --skill setup-traice-collector \
     -g -y
   ```

   If the current agent cannot reload a newly installed skill, read the installed `SKILL.md` directly and continue.

5. Complete every safe local edit and check autonomously. Pause only for browser sign-in, workspace approval, secret
   entry, or a product decision that cannot be inferred from the code.
6. Report what was configured, what was verified, where telemetry will appear, and any remaining human action.

## Account and secret rules

- Never ask the user to paste a trAIce API key into agent chat.
- Never print, inspect, commit, or pass an API key as a command-line argument.
- Treat an existing `TRAICE_API_KEY` value as present without displaying it.
- Interactive collectors use browser authorization and renewable local credentials. Do not create an API key for
  them.
- Product SDKs use a workspace API key. If none exists, open the sign-in and API-key flow described by
  `$setup-traice-sdk`, then use its hidden terminal helper or the deployment platform's secret manager.
- If the user has no account, let the normal trAIce sign-in flow create the account and first workspace. Continue only
  after the user completes that browser step.

## Completion criteria

- The runtime SDK is installed and wraps real application LLM calls when the repository contains them.
- Every selected local coding agent is routed through the collector when collector setup is applicable.
- Relevant tests, type checks, collector status, and route checks pass.
- No secret value appears in the diff, logs, or final response.
