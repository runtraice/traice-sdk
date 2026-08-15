---
name: setup-traice-collector
description: Configure the public trAIce coding-agent collector for Codex and Claude Code on macOS, Linux, or Windows. Use when a user asks to track coding-agent or employee AI spend, connect local agents to trAIce, install or repair @traice/collector, authorize a workspace, configure routes, start the background service, or verify collector health.
---

# Set Up trAIce Collector

Use the maintained `@traice/collector` setup flow. It detects supported agents, uses browser authorization, stores
renewable credentials locally, patches agent telemetry settings, and installs one per-user background service.

## Rules

- Use browser authorization for interactive machines. Do not create or request a workspace API key.
- Keep prompt and output capture disabled. Enable `--include-prompts` only after explicit user authorization.
- Do not import historical usage unless the user explicitly requests it. A dry run may be offered first.
- Preserve existing destinations and routes. Rerun setup to repair or extend them instead of deleting local config.
- Never print credential files or tokens.
- Restarting Codex or Claude Code is a required final step because existing sessions do not reload telemetry settings.

## Workflow

1. Read repository and workstation instructions. Detect the operating system, whether the session is remote or
   headless, and which supported agents are installed.
2. Inspect current state without exposing credentials:

   ```sh
   npx @traice/collector@latest status
   npx @traice/collector@latest destination list
   npx @traice/collector@latest route list
   ```

   Missing first-run config is expected.

3. Run setup. With an interactive desktop, let it open the browser:

   ```sh
   npx @traice/collector@latest setup
   ```

   Over SSH or when no browser is reachable, use:

   ```sh
   npx @traice/collector@latest setup --no-browser
   ```

   Add repeated `--agent codex` and `--agent claude-code` only when detection is ambiguous or the user wants a subset.
   Use `npx.cmd` in Windows PowerShell when script execution policy blocks `npx.ps1`.

4. Surface the plain authorization URL and one-time code to the user, then wait. If the user has no trAIce account,
   the browser flow sends them through sign-in, creates their first workspace, and returns to approval automatically.
5. Let the user approve the exact workspace destinations. Setup continues automatically and stores each renewable
   credential in the OS keyring when available.
6. Verify after setup:

   ```sh
   npx @traice/collector@latest route list
   npx @traice/collector@latest status
   ```

   Require the selected destinations, server connection, background service, and local listener to be healthy.

7. Tell the user to restart every configured Codex and Claude Code session. Do not kill sessions without permission.

## Optional paths

- Multiple workspaces: authorize them in the browser, then verify each agent route with `route list`.
- Different employee or team attribution: rerun setup with the applicable `--employee-email` and `--team-name` values.
- Codex history: start with `backfill codex --since 7d --dry-run`; send only after explicit approval.
- Containers, CI, or managed fleets: API keys remain available through stdin or a managed secret, but do not replace
  the browser flow on an interactive developer machine.
- Service owned elsewhere: use `--no-service` only when another process manager is intentionally responsible.

## Final response

Report configured agents, workspace routes, credential backend without secret values, service and listener status,
whether backfill ran, and the sessions the user must restart.
