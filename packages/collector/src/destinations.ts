import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CollectorIdentity } from "@traice/protocol";
import { resolveHome } from "./fs";
import type {
  AgentName,
  CollectorConfig,
  CollectorCredential,
  CollectorDestination,
  CollectorDestinationIdentity,
  CollectorFolderRouteAgent,
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

export interface CollectorFolderRouteSummary {
  folder: string;
  agent: CollectorFolderRouteAgent;
  destinations: CollectorDestinationSummary[];
}

export type CollectorRouteSource = "override" | "folder" | "agent" | "single-destination";

export interface CollectorRouteCandidate {
  source: CollectorRouteSource;
  matchedFolder?: string;
  matchedAgent?: CollectorFolderRouteAgent;
  destinations: string[];
}

export interface CollectorRouteResolution extends CollectorRouteCandidate {
  agent: AgentName;
  folder?: string;
  fallbacks: CollectorRouteCandidate[];
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

export function routedDestinationNames(
  config: CollectorConfig,
  agent: AgentName,
  override?: string[],
  folder?: string,
): string[] {
  return resolveCollectorRoute(config, agent, { override, folder }).destinations;
}

export function resolveCollectorRoute(
  config: CollectorConfig,
  agent: AgentName,
  options: { override?: string[]; folder?: string } = {},
): CollectorRouteResolution {
  const folder = options.folder ? canonicalFolderPath(options.folder) : undefined;
  const candidates = collectorRouteCandidates(config, agent, folder);
  if (options.override?.length) {
    return {
      agent,
      ...(folder ? { folder } : {}),
      source: "override",
      destinations: validateDestinationSelection(config, options.override),
      fallbacks: candidates,
    };
  }

  const winner = candidates[0];
  if (!winner) return noRouteResolution(config, agent);
  return {
    agent,
    ...(folder ? { folder } : {}),
    ...winner,
    fallbacks: candidates.slice(1),
  };
}

export function allRoutedDestinationNames(config: CollectorConfig, override?: string[]): string[] {
  if (override?.length) {
    const selected = override.map(normalizeDestinationName);
    for (const name of selected) collectorDestination(config, name);
    return selected.filter((name, index, names) => names.indexOf(name) === index);
  }
  const selected = [
    ...config.enabledAgents.flatMap((agent) => routedDestinationNames(config, agent)),
    ...(config.folderRoutes ?? []).flatMap((route) => validateDestinationSelection(config, route.destinations)),
  ];
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

export function setCollectorFolderRoute(
  config: CollectorConfig,
  agent: CollectorFolderRouteAgent,
  requestedFolder: string,
  requestedDestinations: string[],
): CollectorConfig {
  if (requestedDestinations.length === 0)
    throw new Error(`Folder route for "${agent}" needs at least one destination.`);
  const folder = canonicalFolderPath(requestedFolder, true);
  const destinations = validateDestinationSelection(config, requestedDestinations);
  const routes = (config.folderRoutes ?? []).filter(
    (route) => !(canonicalFolderPath(route.folder) === folder && route.agent === agent),
  );
  return { ...config, folderRoutes: [...routes, { folder, agent, destinations }] };
}

export function removeCollectorFolderRoute(
  config: CollectorConfig,
  requestedFolder: string,
  agent?: CollectorFolderRouteAgent,
): CollectorConfig {
  const folder = canonicalFolderPath(requestedFolder);
  const folderRoutes = (config.folderRoutes ?? []).filter(
    (route) => canonicalFolderPath(route.folder) !== folder || (agent !== undefined && route.agent !== agent),
  );
  if (folderRoutes.length === (config.folderRoutes ?? []).length) {
    throw new Error(`No folder route found for "${folder}"${agent === undefined ? "" : ` and agent "${agent}"`}.`);
  }
  return { ...config, ...(folderRoutes.length ? { folderRoutes } : { folderRoutes: undefined }) };
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
    folderRoutes: (config.folderRoutes ?? [])
      .map((route) => ({
        ...route,
        destinations: route.destinations.filter((destination) => destination !== name),
      }))
      .filter((route) => route.destinations.length > 0),
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

export function collectorFolderRouteSummaries(config: CollectorConfig): CollectorFolderRouteSummary[] {
  const destinationByName = new Map(
    collectorDestinationSummaries(config).map((destination) => [destination.name, destination]),
  );
  return (config.folderRoutes ?? [])
    .map((route) => ({
      folder: canonicalFolderPath(route.folder),
      agent: route.agent,
      destinations: validateDestinationSelection(config, route.destinations).map((name) =>
        destinationByName.get(name)!,
      ),
    }))
    .sort((left, right) => left.folder.localeCompare(right.folder) || left.agent.localeCompare(right.agent));
}

export function formatCollectorRouteList(config: CollectorConfig): string {
  const routes = collectorRouteSummaries(config);
  const folderRoutes = collectorFolderRouteSummaries(config);
  if (routes.length === 0 && folderRoutes.length === 0) {
    return 'No routes configured. Run "npx @traice/collector@latest setup".';
  }

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
  if (folderRoutes.length) {
    lines.push("", "Folder overrides", "");
    for (const route of folderRoutes) {
      lines.push(`${route.folder} (${route.agent}) -> ${route.destinations.map((item) => item.name).join(", ")}`);
    }
  }
  lines.push(
    "",
    "Precedence: command override, most specific folder route, agent default, single destination.",
    "Each live event is sent to every destination selected by its winning route.",
  );
  return lines.join("\n");
}

export function formatCollectorRouteExplanation(resolution: CollectorRouteResolution): string {
  const lines = [
    `Agent: ${resolution.agent}`,
    ...(resolution.folder ? [`Folder: ${resolution.folder}`] : []),
    `Selected: ${resolution.destinations.join(", ")}`,
  ];
  if (resolution.source === "folder") {
    lines.push(`Reason: ${resolution.matchedAgent} folder route at ${resolution.matchedFolder}`);
  } else if (resolution.source === "agent") {
    lines.push("Reason: per-agent default route");
  } else if (resolution.source === "override") {
    lines.push("Reason: explicit command override");
  } else {
    lines.push("Reason: only one destination is configured");
  }
  lines.push("Fallback chain:");
  if (resolution.fallbacks.length === 0) lines.push("  - none");
  for (const fallback of resolution.fallbacks) {
    const detail =
      fallback.source === "folder"
        ? `${fallback.matchedAgent} folder route at ${fallback.matchedFolder}`
        : fallback.source === "agent"
          ? "per-agent default route"
          : "single configured destination";
    lines.push(`  - ${detail} -> ${fallback.destinations.join(", ")}`);
  }
  return lines.join("\n");
}

export function canonicalFolderPath(value: string, requireDirectory = false): string {
  const absolute = resolve(resolveHome(value));
  if (requireDirectory) {
    if (!existsSync(absolute)) throw new Error(`Folder does not exist: ${absolute}`);
    if (!statSync(absolute).isDirectory()) throw new Error(`Folder route path is not a directory: ${absolute}`);
  }
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const missingSegments: string[] = [];
  let existingAncestor = absolute;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return absolute;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync.native(existingAncestor), ...missingSegments);
}

function collectorRouteCandidates(
  config: CollectorConfig,
  agent: AgentName,
  folder: string | undefined,
): CollectorRouteCandidate[] {
  const folderCandidates = folder
    ? (config.folderRoutes ?? [])
        .map((route) => ({ ...route, folder: canonicalFolderPath(route.folder) }))
        .filter((route) => (route.agent === agent || route.agent === "all") && isFolderWithin(route.folder, folder))
        .sort(
          (left, right) =>
            right.folder.length - left.folder.length || Number(right.agent === agent) - Number(left.agent === agent),
        )
        .map((route) => ({
          source: "folder" as const,
          matchedFolder: route.folder,
          matchedAgent: route.agent,
          destinations: validateDestinationSelection(config, route.destinations),
        }))
    : [];
  const agentRoute = config.routes?.[agent]?.length
    ? [
        {
          source: "agent" as const,
          destinations: validateDestinationSelection(config, config.routes[agent]!),
        },
      ]
    : [];
  const names = configuredDestinationNames(config);
  const singleDestination =
    names.length === 1 ? [{ source: "single-destination" as const, destinations: [names[0]!] }] : [];
  return [...folderCandidates, ...agentRoute, ...singleDestination];
}

function noRouteResolution(config: CollectorConfig, agent: AgentName): CollectorRouteResolution {
  defaultDestinationName(config, agent);
  throw new Error("No collector route could be resolved.");
}

function isFolderWithin(parent: string, candidate: string): boolean {
  const traversal = relative(parent, candidate);
  return traversal === "" || (traversal !== ".." && !traversal.startsWith(`..${sep}`) && !isAbsolute(traversal));
}

function validateDestinationSelection(config: CollectorConfig, requestedDestinations: string[]): string[] {
  const destinations = requestedDestinations
    .map(normalizeDestinationName)
    .filter((name, index, names) => names.indexOf(name) === index);
  for (const name of destinations) collectorDestination(config, name);
  return destinations;
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
