import { userInfo } from "node:os";
import { dirname } from "node:path";
import { type CollectorSource } from "@traice/protocol";
import type { AgentName, CollectorConfig } from "./types";
import { defaultSourcePrincipal, normalizeUrl, readJsonFile, resolveHome, writePrivateJson } from "./fs";

export const DEFAULT_CONFIG_PATH = "~/.traice/collector/config.json";
export const DEFAULT_SERVER_URL = "https://runtraice.com";

export function resolveConfigPath(path = DEFAULT_CONFIG_PATH): string {
  return resolveHome(path);
}

export function loadCollectorConfig(path = DEFAULT_CONFIG_PATH): CollectorConfig {
  const resolved = resolveConfigPath(path);
  const config = readJsonFile<CollectorConfig>(resolved);
  if (!config)
    throw new Error(`Collector config not found at ${resolved}. Run "traice-collector setup <agent>" first.`);
  return config;
}

export function writeCollectorConfig(config: CollectorConfig, path = DEFAULT_CONFIG_PATH): void {
  writePrivateJson(resolveConfigPath(path), config);
}

export function buildDefaultConfig(now = new Date()): CollectorConfig {
  return {
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    serverUrl: DEFAULT_SERVER_URL,
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
    serverUrl: normalizeUrl(patch.serverUrl ?? base.serverUrl),
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
