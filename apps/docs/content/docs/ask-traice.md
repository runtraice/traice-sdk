---
title: Ask trAIce
excerpt: Query workspace spend, AI contribution margin, waste, budgets, recommendations, and alerts from Slack, the CLI, or any MCP client.
section: Tools
sectionOrder: 4
order: 1
---

# Ask trAIce

Ask trAIce exposes the same attributed cost and financial data shown in the trAIce dashboard. Every answer states how the question was interpreted and links back to the relevant dashboard view. Team workspaces can also prepare a small set of write actions that require a separate, explicit confirmation before anything changes.

Supported reads:

- Spend by workspace, customer, feature, user, model, provider, agent, or tool.
- AI contribution margin by customer.
- Feature-attributed AI cost. Feature margin is not calculated because feature revenue is not mapped.
- Top detected waste and cost-validated savings recommendations.
- Current budget status and active alerts.

Confirmed Team actions:

- Create a workspace, feature, user, or tenant budget.
- Snooze a non-system alert for a bounded period.
- Create an evidence-gated guardrail from an eligible experiment in shadow mode.

Preparing an action does not execute it. trAIce returns a summary, a short-lived token, and an exact confirmation phrase. The token expires after 10 minutes, is bound to the same MCP authorization or workspace API key, and can be confirmed only with that exact phrase. Repeating a successful confirmation returns the stored result instead of executing the action again.

## CLI

Install the CLI:

```sh
npm install --global @traice/sdk
```

Save a workspace API key once:

```sh
export TRAICE_API_KEY="lm_live_..."
traice auth login
unset TRAICE_API_KEY
```

The CLI stores the key in macOS Keychain, Linux Secret Service, or Windows Credential Manager. If the native credential store is unavailable, it uses a user-only protected file and prints the location and warning.

Ask a question:

```sh
traice ask "which customers are unprofitable this month?"
traice ask "top spend by model in the last 7 days"
traice ask "what is our biggest waste and what should we change?"
```

Prepare a budget, review the printed summary, then run the confirmation command printed by the CLI:

```sh
traice action prepare-budget \
  --name "Support monthly budget" \
  --limit-usd 500 \
  --scope FEATURE \
  --scope-value support-assistant
```

Other supported preparations:

```sh
traice action prepare-alert-snooze ALERT_ID --hours 24 --reason "Investigating"
traice action prepare-shadow-guardrail EXPERIMENT_ID
```

The CLI never confirms during preparation. Confirmation is a separate command containing the returned token and exact phrase:

```sh
traice action confirm --token 'SHORT_LIVED_TOKEN' --phrase 'CONFIRM ABC123'
```

Use `--json` for automation. Use `traice auth logout` to delete the saved credential.

## Slack

A trAIce workspace owner or admin can connect Ask trAIce to a Slack workspace:

1. Sign in to [trAIce](https://www.runtraice.com/login) and select the intended workspace.
2. Open **Settings**, then **Ask trAIce**.
3. Select **Add to Slack**.
4. Choose the Slack workspace and approve the requested read and reply permissions.

Use the app after installation:

```text
/traice top spend by model in the last 7 days
/traice which customers are unprofitable this month?
```

You can also mention Ask trAIce in a channel where the app is present. Slash-command answers include a link to the relevant trAIce dashboard view; mention answers are posted in a thread.

The Slack app is available for OAuth installation in any workspace. If your Slack organization restricts app installation, a Slack workspace or organization admin must approve it. One Slack workspace can be connected to only one trAIce workspace at a time.

Install through trAIce Settings rather than a copied Slack authorization URL. The Settings flow securely binds the Slack authorization to the selected trAIce workspace.

## Cursor

Create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "traice": {
      "url": "https://www.runtraice.com/api/mcp"
    }
  }
}
```

Start or refresh the server in Cursor. trAIce opens in your browser, where you sign in, select the workspace by name,
and authorize the client. Cursor stores and refreshes its OAuth session. No trAIce API key needs to be copied into the
project.

Confirm the seven read tools appear: `spend_by`, `margin_by_customer`, `margin_by_feature`, `top_waste`,
`savings_recommendations`, `budget_status`, and `active_alerts`. Team workspaces also expose `prepare_write_action` and
`confirm_write_action`. An MCP client must show the prepared summary and ask the user to repeat the exact confirmation
phrase before calling `confirm_write_action`.

Cursor may hot reload MCP changes. If the tools do not refresh, restart the MCP server or start a new Cursor agent
session. OAuth token refresh itself does not require restarting Cursor. See the
[Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol).

## VS Code

Add this to `.vscode/mcp.json`, or use **MCP: Add Server** and enter the same URL:

```json
{
  "servers": {
    "traice": {
      "type": "http",
      "url": "https://www.runtraice.com/api/mcp"
    }
  }
}
```

Start the server and approve its trust prompt. VS Code follows MCP OAuth discovery, opens trAIce for workspace consent,
and manages the resulting tokens. After changing `mcp.json`, restart the server from **MCP: List Servers** if the tools
do not refresh automatically. See the
[VS Code MCP server guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

## API-key fallback for unattended MCP clients

Use a workspace API key only when the MCP client cannot complete browser OAuth, such as CI or a headless service.
Store it in a secret manager and send it as a bearer token:

```json
{
  "mcpServers": {
    "traice": {
      "url": "https://www.runtraice.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:TRAICE_API_KEY}"
      }
    }
  }
}
```

Do not commit the key. Interactive desktop clients should use the URL-only OAuth configuration above.

## Direct API

The CLI calls the same workspace-authenticated endpoint:

```sh
curl -X POST "https://www.runtraice.com/api/v1/ask" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"question":"top spend by customer in the last 30 days"}'
```

Questions are limited to fixed read tools. Ask trAIce does not run freeform SQL.

Team workspaces can prepare an action through a separate endpoint:

```sh
curl -X POST "https://www.runtraice.com/api/v1/ask/actions/prepare" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "action": "create_budget",
    "name": "Support monthly budget",
    "limitUsd": 500,
    "scope": "FEATURE",
    "scopeValue": "support-assistant",
    "period": "MONTHLY"
  }'
```

After a person reviews the returned summary, confirm it with the returned token and exact phrase:

```sh
curl -X POST "https://www.runtraice.com/api/v1/ask/actions/confirm" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "confirmationToken": "SHORT_LIVED_TOKEN",
    "confirmationPhrase": "CONFIRM ABC123"
  }'
```

Confirmation tokens expire after 10 minutes and must be used with the same OAuth grant or API key that prepared the action. A confirmed request is replay-safe: retrying it returns the original result. Experiment guardrails are always created in shadow mode and still require the normal evidence and eligibility checks.
