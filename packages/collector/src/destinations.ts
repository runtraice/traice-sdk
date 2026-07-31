import type { CollectorIdentity } from "@traice/protocol";
import type {
  AgentName,
  CollectorConfig,
  CollectorCredential,
  CollectorDestination,
  CollectorDestinationIdentity,
} from "./types";

const DESTINATION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface CollectorDestinationSummary {
  name: string;
  workspaceName?: string;
  workspaceId?: string;
  userEmail?: string;
  serverUrl: string;
  credentialBackend?: CollectorCredential["backend"];
}

export interface CollectorRouteSummary {
  agent: AgentName;
  destinations: CollectorDestinationSummary[];
}

export type ResolvedCollectorConfig = Omit<CollectorConfig, "identity"> &
  CollectorDestination & {
    identity: CollectorConfig["identity"];
  };

export function normalizeDestinationName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!DESTINATION_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid destination "${value}". Use 1 to 64 lowercase letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  return normalized;
}

export function destinationNameFromWorkspace(
  workspace: { id: string; name: string; slug?: string },
  configured: Record<string, CollectorDestination>,
  serverUrl?: string,
): string {
  const base = slugifyDestination(workspace.slug ?? workspace.name);
  const existing = configured[base];
  if (
    !existing ||
    (existing.authorization?.workspaceId === workspace.id && (!serverUrl || existing.serverUrl === serverUrl))
  ) {
    return base;
  }
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base.slice(0, 61)}-${suffix}`;
    const candidateDestination = configured[candidate];
    if (
      !candidateDestination ||
      (candidateDestination.authorization?.workspaceId === workspace.id &&
        (!serverUrl || candidateDestination.serverUrl === serverUrl))
    ) {
      return candidate;
    }
  }
  return `workspace-${workspace.id.slice(-8).toLowerCase()}`;
}

export function collectorDestination(config: CollectorConfig, requestedDestination: string): CollectorDestination {
  const name = normalizeDestinationName(requestedDestination);
  const destination = config.destinations[name];
  if (!destination) throw new Error(`Collector destination "${name}" was not found.`);
  return destination;
}

export function configForDestination(config: CollectorConfig, requestedDestination: string): ResolvedCollectorConfig {
  const destination = collectorDestination(config, requestedDestination);
  return {
    ...config,
    ...destination,
    identity: effectiveDestinationIdentity(config.identity, destination.identity),
  };
}

function effectiveDestinationIdentity(
  base: CollectorIdentity,
  override?: CollectorDestinationIdentity,
): CollectorIdentity {
  const identity = { ...base };
  if (!override) return identity;
  for (const key of identityKeys) {
    const value = override[key];
    if (value === undefined) continue;
    if (value === null) delete identity[key];
    else Object.assign(identity, { [key]: value });
  }
  return identity;
}

const identityKeys = [
  "employeeEmail",
  "employeeName",
  "employeeExternalId",
  "teamName",
  "teamExternalId",
  "sourcePrincipal",
  "seatMonthlyUsd",
] as const;

export function configuredDestinationNames(config: CollectorConfig): string[] {
  return Object.keys(config.destinations).map(normalizeDestinationName);
}

export function defaultDestinationName(config: CollectorConfig, agent?: AgentName): string {
  const routed = agent ? config.routes?.[agent] : undefined;
  if (routed?.length) return normalizeDestinationName(routed[0]!);
  const names = configuredDestinationNames(config);
  if (names.length === 1) return names[0]!;
  if (names.length === 0) throw new Error('No collector destination is configured. Run "traice-collector auth login".');
  throw new Error("More than one destination is configured. Add --destination <name> or set an agent route.");
}

export function routedDestinationNames(config: CollectorConfig, agent: AgentName, override?: string[]): string[] {
  const selected = (override?.length ? override : config.routes?.[agent])?.map(normalizeDestinationName);
  if (!selected?.length) return [defaultDestinationName(config, agent)];
  const unique = selected.filter((name, index, names) => names.indexOf(name) === index);
  for (const name of unique) collectorDestination(config, name);
  return unique;
}

export function allRoutedDestinationNames(config: CollectorConfig, override?: string[]): string[] {
  if (override?.length) {
    const selected = override.map(normalizeDestinationName);
    for (const name of selected) collectorDestination(config, name);
    return selected.filter((name, index, names) => names.indexOf(name) === index);
  }
  const selected = config.enabledAgents.flatMap((agent) => routedDestinationNames(config, agent));
  if (selected.length === 0) return [defaultDestinationName(config)];
  return selected.filter((name, index, names) => names.indexOf(name) === index);
}

export function setCollectorRoute(
  config: CollectorConfig,
  agent: AgentName,
  requestedDestinations: string[],
): CollectorConfig {
  if (requestedDestinations.length === 0) throw new Error(`Route for "${agent}" needs at least one destination.`);
  const destinations = requestedDestinations
    .map(normalizeDestinationName)
    .filter((name, index, names) => names.indexOf(name) === index);
  for (const name of destinations) collectorDestination(config, name);
  return { ...config, routes: { ...config.routes, [agent]: destinations } };
}

export function upsertCollectorDestination(
  config: CollectorConfig,
  requestedName: string,
  destination: CollectorDestination,
): CollectorConfig {
  const name = normalizeDestinationName(requestedName);
  const current = config.destinations[name];
  return {
    ...config,
    destinations: {
      ...config.destinations,
      [name]: {
        ...destination,
        ...(destination.identity === undefined && current?.identity ? { identity: current.identity } : {}),
        ...(destination.context === undefined && current?.context ? { context: current.context } : {}),
      },
    },
  };
}

export function removeCollectorDestination(config: CollectorConfig, requestedName: string): CollectorConfig {
  const name = normalizeDestinationName(requestedName);
  const destinations = { ...config.destinations };
  delete destinations[name];
  return {
    ...config,
    destinations,
    routes: Object.fromEntries(
      Object.entries(config.routes ?? {}).map(([agent, route]) => [
        agent,
        route?.filter((destination) => destination !== name),
      ]),
    ),
  };
}

export function collectorDestinationSummaries(config: CollectorConfig): CollectorDestinationSummary[] {
  return configuredDestinationNames(config).map((name) => {
    const destination = collectorDestination(config, name);
    return {
      name,
      serverUrl: destination.serverUrl,
      ...(destination.credential ? { credentialBackend: destination.credential.backend } : {}),
      ...(destination.authorization
        ? {
            workspaceName: destination.authorization.workspaceName,
            workspaceId: destination.authorization.workspaceId,
            userEmail: destination.authorization.userEmail,
          }
        : {}),
    };
  });
}

export function collectorRouteSummaries(config: CollectorConfig): CollectorRouteSummary[] {
  const agents = Array.from(
    new Set([
      ...config.enabledAgents,
      ...Object.keys(config.routes ?? {}).filter(
        (agent): agent is AgentName => agent === "codex" || agent === "claude-code",
      ),
    ]),
  );
  const destinationByName = new Map(
    collectorDestinationSummaries(config).map((destination) => [destination.name, destination]),
  );
  return agents.map((agent) => ({
    agent,
    destinations: routedDestinationNames(config, agent).map((name) => destinationByName.get(name)!),
  }));
}

export function formatCollectorRouteList(config: CollectorConfig): string {
  const routes = collectorRouteSummaries(config);
  if (routes.length === 0) return 'No routes configured. Run "npx @traice/collector@latest setup".';

  const lines = ["Collector routes", ""];
  for (const [routeIndex, route] of routes.entries()) {
    const agent = route.agent === "codex" ? "Codex" : "Claude Code";
    lines.push(`${agent} -> ${route.destinations.length} destination${route.destinations.length === 1 ? "" : "s"}`);
    for (const destination of route.destinations) {
      const workspace = destination.workspaceName ?? destination.workspaceId ?? "API key workspace";
      const account = destination.userEmail ? ` | ${destination.userEmail}` : "";
      lines.push(`  - ${destination.name}`);
      lines.push(`    ${workspace}${account} | ${displayServer(destination.serverUrl)}`);
    }
    if (routeIndex < routes.length - 1) lines.push("");
  }
  lines.push("", "Each live event is sent to every destination listed for its agent.");
  return lines.join("\n");
}

function slugifyDestination(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  return normalized || "workspace";
}

function displayServer(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}
