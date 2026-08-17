---
title: Coding-Agent Setup
excerpt: Install public trAIce skills and let a coding agent configure the SDK and local collectors.
section: Getting started
sectionOrder: 1
order: 3
---

# Coding-Agent Setup

The public setup skills let a coding agent inspect a repository, choose the correct trAIce integrations, make the
local code changes, and verify them. Product-runtime telemetry and coding-agent telemetry remain separate.

## Install the skills

Run this once on the machine that hosts your coding agent:

```sh
npx skills add runtraice/traice-sdk \
  --skill setup-traice \
  --skill setup-traice-sdk \
  --skill setup-traice-collector \
  -g -y
```

The open `skills` CLI supports Codex, Claude Code, Cursor, and other Agent Skills-compatible tools. The skills are
installed from the public [trAIce SDK repository](https://github.com/runtraice/traice-sdk/tree/main/skills).

## Give this prompt to your coding agent

```text
Set up trAIce in this repository.

Install the public setup skills from runtraice/traice-sdk if they are not installed, then run $setup-traice. Configure
the product SDK if this application calls LLMs, and configure every detected Codex or Claude Code collector on this
machine.

If I do not have a trAIce account or workspace key, open
https://www.runtraice.com/login?callbackUrl=%2Fapp%2Fapi-keys and wait for me to finish sign-in and key creation. Never
ask me to paste an API key into chat or pass it in command arguments. Use the skill's hidden terminal credential flow
or my deployment secret manager.

Verify the integration, keep prompts and outputs disabled in collectors, and report exactly what changed and what I
need to restart.
```

## What the skills do

- `$setup-traice` inspects the project and routes to one or both focused skills.
- `$setup-traice-sdk` installs the TypeScript or Python SDK, instruments real server-side LLM calls, maps existing
  product attribution, and verifies the repository.
- `$setup-traice-collector` detects Codex and Claude Code, starts browser authorization, configures workspace routes,
  patches telemetry settings, installs the user service, and checks health.

## New accounts and API keys

If you have not signed up, trAIce creates the account and first workspace during sign-in. The SDK setup skill then
waits while you create a workspace API key. It never asks for that key in agent chat. For local development, its
bundled helper accepts the key through hidden terminal input and refuses tracked or non-ignored environment files. For
CI and hosting, the agent uses the platform secret manager already in scope. During an SSH session, open the sign-in
URL in any browser, then enter the new key into the remote terminal through the helper's hidden prompt.

Collector setup is keyless on interactive machines. Its device flow can be completed in any browser, including from
another device during an SSH session. The collector stores renewable credentials in the operating system keyring when
available.

## Verify the result

The agent runs repository tests for SDK changes and these collector checks when applicable:

```sh
npx @traice/collector@latest route list
npx @traice/collector@latest status
```

Restart configured Codex and Claude Code sessions after collector setup. Existing sessions do not reload telemetry
settings.
