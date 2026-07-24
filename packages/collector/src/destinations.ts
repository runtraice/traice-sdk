import type { AgentName, CollectorConfig, CollectorDestination, CollectorCredential } from "./types";

const DESTINATION_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface CollectorDestinationSummary {
  name: string;
  workspaceName?: string;
  workspaceId?: string;
  userEmail?: string;
  serverUrl: string;
  credentialBackend?: CollectorCredential["backend"];
}

export type ResolvedCollectorConfig = CollectorConfig & CollectorDestination;

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
  return { ...config, ...collectorDestination(config, requestedDestination) };
}

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
  return { ...config, destinations: { ...config.destinations, [name]: destination } };
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

function slugifyDestination(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  return normalized || "workspace";
}
