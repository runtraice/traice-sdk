import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { type CollectorSource } from "@traice/protocol";
import type {
  AgentName,
  CollectorConfig,
  CollectorCredential,
  CollectorDestination,
  CollectorOAuthAuthorization,
} from "./types";
import { defaultSourcePrincipal, normalizeUrl, readJsonFile, resolveHome, writePrivateJson } from "./fs";

export const DEFAULT_CONFIG_PATH = "~/.traice/collector/config.json";
export const DEFAULT_SERVER_URL = "https://www.runtraice.com";

export function resolveConfigPath(path = DEFAULT_CONFIG_PATH): string {
  return resolveHome(path);
}

export function loadCollectorConfig(path = DEFAULT_CONFIG_PATH): CollectorConfig {
  const resolved = resolveConfigPath(path);
  const raw = readJsonFile<CollectorConfig | LegacyCollectorConfig>(resolved);
  if (!raw) throw new Error(`Collector config not found at ${resolved}. Run "traice-collector setup" first.`);
  if (raw.version === 2) return raw;
  // Keep reads side-effect free. A newer CLI can inspect an older config while an
  // older pinned background service is still running. Persisting the migration
  // here would make that service read a schema it does not understand and crash.
  return migrateLegacyConfig(raw);
}

export function writeCollectorConfig(config: CollectorConfig, path = DEFAULT_CONFIG_PATH): void {
  const resolved = resolveConfigPath(path);
  backupCollectorConfig(resolved);
  writePrivateJson(resolved, config);
}

export function buildDefaultConfig(now = new Date()): CollectorConfig {
  return {
    version: 2,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    destinations: {},
    listenHost: "127.0.0.1",
    listenPort: 4318,
    includePrompts: false,
    enabledAgents: [],
    identity: {
      employeeEmail: undefined,
      employeeName: userInfo().username,
      sourcePrincipal: defaultSourcePrincipal(),
    },
    sources: {},
  };
}

export function mergeConfigForAgent(
  current: CollectorConfig | null,
  agent: AgentName,
  patch: Partial<CollectorConfig>,
): CollectorConfig {
  const now = new Date().toISOString();
  const base = current ?? buildDefaultConfig(new Date(now));
  const enabledAgents = base.enabledAgents.includes(agent) ? base.enabledAgents : [...base.enabledAgents, agent];

  return {
    ...base,
    ...patch,
    destinations: patch.destinations ?? base.destinations,
    enabledAgents,
    identity: {
      ...base.identity,
      ...patch.identity,
    },
    sources: {
      ...base.sources,
      ...patch.sources,
    },
    createdAt: base.createdAt,
    updatedAt: now,
  };
}

export function defaultSourceForAgent(agent: AgentName): CollectorSource {
  if (agent === "claude-code") {
    return {
      sourceKey: "claude-code-local",
      sourceName: "Claude Code local collector",
      sourceKind: "claude_code_otel",
      tool: "claude-code",
      category: "coding_agent",
    };
  }

  return {
    sourceKey: "codex-local",
    sourceName: "Codex local collector",
    sourceKind: "codex_otel",
    tool: "codex",
    category: "coding_agent",
  };
}

export function configDir(path = DEFAULT_CONFIG_PATH): string {
  return dirname(resolveConfigPath(path));
}

type LegacyDestination = {
  serverUrl: string;
  credential?: CollectorCredential;
  authorization?: CollectorOAuthAuthorization;
  apiKey?: string;
};

type LegacyCollectorConfig = Omit<CollectorConfig, "version" | "destinations"> & {
  version: 1;
  serverUrl: string;
  apiKey?: string;
  credential?: CollectorCredential;
  authorization?: CollectorOAuthAuthorization;
  profiles?: Record<string, LegacyDestination>;
  activeProfile?: string;
  mirrorProfiles?: string[];
};

function migrateLegacyConfig(legacy: LegacyCollectorConfig): CollectorConfig {
  const destinations: Record<string, CollectorDestination> = {};
  const defaultDestination = legacy.credential || legacy.apiKey ? legacyDestinationName(legacy, legacy.profiles) : null;
  if (defaultDestination) {
    destinations[defaultDestination] = {
      serverUrl: normalizeUrl(legacy.serverUrl || DEFAULT_SERVER_URL),
      ...(legacy.credential ? { credential: legacy.credential } : {}),
      ...(legacy.authorization ? { authorization: legacy.authorization } : {}),
      ...(legacy.apiKey ? { apiKey: legacy.apiKey } : {}),
    };
  }
  for (const [name, destination] of Object.entries(legacy.profiles ?? {})) {
    destinations[normalizeDestinationName(name)] = {
      serverUrl: normalizeUrl(destination.serverUrl),
      ...(destination.credential ? { credential: destination.credential } : {}),
      ...(destination.authorization ? { authorization: destination.authorization } : {}),
      ...(destination.apiKey ? { apiKey: destination.apiKey } : {}),
    };
  }

  const replaceDefault = (name: string) =>
    name === "default" && defaultDestination ? defaultDestination : normalizeDestinationName(name);
  const fallback = [
    replaceDefault(legacy.activeProfile ?? "default"),
    ...(legacy.mirrorProfiles ?? []).map(replaceDefault),
  ].filter((name, index, names) => destinations[name] && names.indexOf(name) === index);
  const routes = Object.fromEntries(
    legacy.enabledAgents.map((agent) => {
      const configured = legacy.routes?.[agent]?.map(replaceDefault).filter((name) => destinations[name]);
      return [agent, configured?.length ? configured : fallback];
    }),
  ) as CollectorConfig["routes"];

  return {
    version: 2,
    createdAt: legacy.createdAt,
    updatedAt: new Date().toISOString(),
    destinations,
    ...(routes && Object.values(routes).some((route) => route?.length) ? { routes } : {}),
    listenHost: legacy.listenHost,
    listenPort: legacy.listenPort,
    includePrompts: legacy.includePrompts,
    enabledAgents: legacy.enabledAgents,
    identity: legacy.identity,
    sources: legacy.sources,
    ...(legacy.telemetryEnabledAt ? { telemetryEnabledAt: legacy.telemetryEnabledAt } : {}),
    ...(legacy.claudeHome ? { claudeHome: legacy.claudeHome } : {}),
    ...(legacy.codexHome ? { codexHome: legacy.codexHome } : {}),
  };
}

function legacyDestinationName(legacy: LegacyCollectorConfig, additional: LegacyCollectorConfig["profiles"]): string {
  const base = normalizeDestinationName(
    legacy.authorization?.workspaceSlug ?? legacy.authorization?.workspaceName ?? "workspace",
  );
  if (!additional?.[base]) return base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!additional[candidate]) return candidate;
  }
  return "migrated-workspace";
}

function normalizeDestinationName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 64);
  return normalized || "workspace";
}

function backupCollectorConfig(path: string): void {
  if (!existsSync(path)) return;
  const backupDirectory = resolve(dirname(path), "backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(backupDirectory, `config-${timestamp}.json`);
  try {
    copyFileSync(path, backupPath);
  } catch {
    writePrivateJson(backupPath, readJsonFile<unknown>(path));
  }
  const backups = readdirSync(backupDirectory)
    .filter((name) => /^config-.*\.json$/.test(name))
    .sort()
    .reverse();
  for (const name of backups.slice(20)) rmSync(resolve(backupDirectory, name), { force: true });
}
