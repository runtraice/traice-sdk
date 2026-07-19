---
title: Ask trAIce
excerpt: Query workspace spend, AI contribution margin, waste, budgets, recommendations, and alerts from the CLI or any MCP client.
order: 7
---

# Ask trAIce

Ask trAIce is a read-only agent surface over the same attributed cost and financial data shown in the trAIce dashboard. Every answer states how the question was interpreted and links back to the relevant dashboard view.

Supported reads:

- Spend by workspace, customer, feature, user, model, provider, agent, or tool.
- AI contribution margin by customer.
- Feature-attributed AI cost. Feature margin is not calculated because feature revenue is not mapped.
- Top detected waste and cost-validated savings recommendations.
- Current budget status and active alerts.

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

Use `--json` for automation. Use `traice auth logout` to delete the saved credential.

## Cursor

Set `TRAICE_API_KEY` in the environment that launches Cursor. Then create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

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

Restart or reload Cursor, open MCP settings, and confirm these read-only tools appear: `spend_by`, `margin_by_customer`, `margin_by_feature`, `top_waste`, `savings_recommendations`, `budget_status`, and `active_alerts`.

If Cursor was launched from a desktop icon on Linux or macOS, it might not inherit shell environment variables. Launch it once from a terminal where `TRAICE_API_KEY` is available, or configure the variable in the desktop session environment. See the [Cursor MCP documentation](https://docs.cursor.com/context/model-context-protocol).

## VS Code

VS Code supports password inputs so the key does not need to be committed. Add this to `.vscode/mcp.json`:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "traice-api-key",
      "description": "trAIce workspace API key",
      "password": true
    }
  ],
  "servers": {
    "traice": {
      "type": "http",
      "url": "https://www.runtraice.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${input:traice-api-key}"
      }
    }
  }
}
```

See the [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) for profile-level configuration.

## Direct API

The CLI calls the same workspace-authenticated endpoint:

```sh
curl -X POST "https://www.runtraice.com/api/v1/ask" \
  -H "authorization: Bearer $TRAICE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"question":"top spend by customer in the last 30 days"}'
```

Questions are limited to fixed read-only tools. Ask trAIce does not run freeform SQL and cannot mutate budgets, alerts, rules, or workspace data.
