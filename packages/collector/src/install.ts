import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_SERVER_URL,
  buildDefaultConfig,
  defaultSourceForAgent,
  loadCollectorConfig,
  mergeConfigForAgent,
  resolveConfigPath,
  writeCollectorConfig,
} from "./config";
import { normalizeUrl, parseMoney, parsePort, readStdinSecret, resolveHome } from "./fs";
import { patchClaudeSettings, patchCodexConfig, type SettingsPatchResult } from "./settings";
import { storeCollectorCredential } from "./credentials";
import {
  collectorDestination,
  defaultDestinationName,
  normalizeDestinationName,
  upsertCollectorDestination,
} from "./destinations";
import type { AgentName, CollectorConfig, CollectorCredential, CollectorInstallOptions } from "./types";

export interface InstallResult {
  ok: true;
  agent: AgentName;
  destination: string;
  configPath: string;
  credential: CollectorCredential;
  credentialWarning?: string;
  settings: SettingsPatchResult;
  nextCommand: string;
}

export async function installAgent(options: CollectorInstallOptions): Promise<InstallResult> {
  const configPath = resolveConfigPath(options.configPath);
  const current = existsSync(configPath) ? loadCurrentConfig(configPath) : null;
  const destinationName = normalizeDestinationName(
    options.destination ?? (current ? defaultDestinationName(current, options.agent) : "api-key"),
  );
  let currentDestination: ReturnType<typeof collectorDestination> | null = null;
  if (current) {
    try {
      currentDestination = collectorDestination(current, destinationName);
    } catch {
      currentDestination = null;
    }
  }
  const providedApiKey = options.apiKeyStdin
    ? await readStdinSecret()
    : (options.apiKey ?? currentDestination?.apiKey ?? process.env.TRAICE_API_KEY);
  let credential = currentDestination?.credential;
  let credentialWarning: string | undefined;
  if (providedApiKey) {
    const stored = await storeCollectorCredential(
      configPath,
      providedApiKey,
      options.credentialStore,
      {},
      destinationName,
    );
    credential = stored.credential;
    credentialWarning = stored.warning;
  }
  if (!credential) {
    throw new Error("Missing collector credential. Run auth login or provide TRAICE_API_KEY or --api-key-stdin.");
  }
  const listenHost = options.listenHost ?? current?.listenHost ?? "127.0.0.1";
  const listenPort = parsePort(options.listenPort ?? current?.listenPort, 4318);
  const includePrompts = Boolean(options.includePrompts ?? current?.includePrompts ?? false);
  const now = new Date();
  const base = current ?? buildDefaultConfig(now);
  const agentHomePatch =
    options.agent === "claude-code"
      ? { claudeHome: resolveHome(options.claudeHome ?? base.claudeHome ?? "~/.claude") }
      : { codexHome: resolveHome(options.codexHome ?? base.codexHome ?? "~/.codex") };

  const serverUrl = normalizeUrl(options.serverUrl ?? currentDestination?.serverUrl ?? DEFAULT_SERVER_URL);
  let next = mergeConfigForAgent(current, options.agent, {
    listenHost,
    listenPort,
    includePrompts,
    identity: {
      employeeEmail:
        options.employeeEmail ?? current?.identity.employeeEmail ?? currentDestination?.authorization?.userEmail,
      employeeName: options.employeeName ?? current?.identity.employeeName ?? userInfo().username,
      employeeExternalId: options.employeeExternalId ?? current?.identity.employeeExternalId,
      teamName: options.teamName ?? current?.identity.teamName,
      teamExternalId: options.teamExternalId ?? current?.identity.teamExternalId,
      sourcePrincipal: options.sourcePrincipal ?? current?.identity.sourcePrincipal,
      seatMonthlyUsd: parseMoney(options.seatMonthlyUsd ?? current?.identity.seatMonthlyUsd),
    },
    sources: {
      [options.agent]: defaultSourceForAgent(options.agent),
    },
    ...agentHomePatch,
  });
  next = upsertCollectorDestination(next, destinationName, {
    serverUrl,
    credential,
    ...(providedApiKey
      ? {}
      : currentDestination?.authorization
        ? { authorization: currentDestination.authorization }
        : {}),
  });
  if (!next.routes?.[options.agent]?.length) {
    next.routes = { ...next.routes, [options.agent]: [destinationName] };
  }

  writeCollectorConfig(next, configPath);

  const settings =
    options.agent === "claude-code"
      ? patchClaudeSettings({
          claudeHome: next.claudeHome ?? resolve(homedir(), ".claude"),
          listenHost,
          listenPort,
          includePrompts,
          patch: Boolean(options.patchSettings),
        })
      : patchCodexConfig({
          codexHome: next.codexHome ?? resolve(homedir(), ".codex"),
          listenHost,
          listenPort,
          includePrompts,
          patch: Boolean(options.patchSettings),
        });
  if (settings.status === "patched" && !next.telemetryEnabledAt?.[options.agent]) {
    next = {
      ...next,
      telemetryEnabledAt: {
        ...next.telemetryEnabledAt,
        [options.agent]: now.toISOString(),
      },
    };
    writeCollectorConfig(next, configPath);
  }

  return {
    ok: true,
    agent: options.agent,
    destination: destinationName,
    configPath,
    credential,
    ...(credentialWarning ? { credentialWarning } : {}),
    settings,
    nextCommand: `npx @traice/collector@latest collect --config ${configPath}`,
  };
}

function loadCurrentConfig(path: string): CollectorConfig {
  return loadCollectorConfig(path);
}
