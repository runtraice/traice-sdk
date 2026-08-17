---
title: Collector Routing
excerpt: Route Codex and Claude Code sessions to authorized workspaces by agent, repository, or worktree.
section: Internal spend
sectionOrder: 3
order: 3
---

# Collector Routing

Routing selects which authorized destination receives a collector event. Configure a default for each agent, then
add folder rules only where a repository or worktree needs different behavior.

## Configure default routes

List authorized destinations and current routes:

```bash
npx @traice/collector@latest destination list
npx @traice/collector@latest route list
```

Set one or more destinations for each agent:

```bash
npx @traice/collector@latest route set codex engineering
npx @traice/collector@latest route set claude-code engineering audit
```

A route with multiple destinations fans out each event to every destination in that route. Each destination keeps an
independent credential, durable queue, retry stream, and deduplication boundary.

## Add folder routes

Use a folder rule when a repository or worktree should override the agent default:

```bash
npx @traice/collector@latest route set codex sandbox --folder "$PWD"
npx @traice/collector@latest route set all sandbox --folder "$PWD"
npx @traice/collector@latest route explain --agent codex --folder "$PWD"
```

The folder must exist when the rule is created. The collector stores its canonical absolute path and matches that
directory plus all descendants. This includes nested repositories and worktree directories located below the routed
folder. A linked worktree outside that directory tree needs its own rule.

Use `all` for a rule shared by Codex and Claude Code. Use an agent name when only that agent should match.

## Route priority

The resolver evaluates one ordered chain:

1. An explicit command destination override
2. Matching folder rules, with the longest canonical folder path first
3. At the same folder, the agent-specific rule before `all`
4. The per-agent default route
5. The only configured destination

Only the winning route sends the event. Lower-priority rules are fallbacks, not additional destinations. Destinations
inside the winning route are all selected.

Folder specificity is evaluated before agent specificity. For example, an `all` rule on a repository beats a Codex
rule on its parent directory. A Codex rule beats an `all` rule only when both match the same folder.

An explicit `--destination` option remains highest priority. Codex backfill accepts that override:

```bash
npx @traice/collector@latest backfill codex --destination engineering --since 7d
```

## Explain and remove rules

Inspect the selected route and complete fallback chain before changing a rule:

```bash
npx @traice/collector@latest route explain --agent codex --folder "$PWD"
```

Remove one agent's folder rule or every rule at a folder:

```bash
npx @traice/collector@latest route remove --agent codex --folder "$PWD"
npx @traice/collector@latest route remove --folder "$PWD"
```

`route set` replaces the destinations for the same agent and folder. Folder rules can reference only destinations
already authorized on the device. Repository files cannot create or change collector routes.

## Missing session folders

The collector resolves Codex and Claude Code working folders from supported local session metadata. When a session
folder is unavailable, routing falls back to the per-agent default and then to a single configured destination. If
multiple destinations exist and neither fallback is configured, the collector cannot resolve a route for that event.

`route list` marks agents without a usable default as unresolved. With folder rules active, `status` reports the
number of unique sessions with resolved and unresolved folders observed since the current service started.

Live collection and Codex backfill use the same route resolver. Without an explicit backfill destination, each Codex
history session is routed from its recorded folder and follows the same fallback chain as a live session.

## Machine-readable output

Use JSON for automation:

```bash
npx @traice/collector@latest route list --json
npx @traice/collector@latest route explain --agent codex --folder "$PWD" --json
```

`route list --json` returns an object with `agents` and `folders` arrays. `route explain --json` returns the selected
route, its source, the canonical local folder, and ordered fallbacks. These local command results can contain folder,
workspace, and account metadata, so review them before sharing.

Collector versions before folder routing returned the `route list --json` agent array directly. Folder-aware versions
wrap it in the `agents` field and add `folders`. Update scripts that consume this command output when upgrading.

## Privacy boundary

Session folders and configured folder paths remain on the collector device. They guide destination selection but are
never included in uploaded telemetry. See [Collector Configuration](/docs/collector-configuration) for storage and
compatibility details.
