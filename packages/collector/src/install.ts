import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_SERVER_URL,
  buildDefaultConfig,
  defaultSourceForAgent,
  mergeConfigForAgent,
  resolveConfigPath,
  writeCollectorConfig,
} from "./config";
import { normalizeUrl, parseMoney, parsePort, readJsonFile, readStdinSecret, resolveHome } from "./fs";
import { patchClaudeSettings, patchCodexConfig, type SettingsPatchResult } from "./settings";
import { storeCollectorCredential } from "./credentials";
import {
  DEFAULT_PROFILE,
  activeProfileName,
  collectorProfile,
  normalizeProfileName,
  upsertCollectorProfile,
} from "./profiles";
import type { AgentName, CollectorConfig, CollectorCredential, CollectorInstallOptions } from "./types";

export interface InstallResult {
  ok: true;
  agent: AgentName;
  profile: string;
  configPath: string;
  credential: CollectorCredential;
  credentialWarning?: string;
  settings: SettingsPatchResult;
  nextCommand: string;
}

export async function installAgent(options: CollectorInstallOptions): Promise<InstallResult> {
  const configPath = resolveConfigPath(options.configPath);
  const current = existsSync(configPath) ? readJsonFile<CollectorConfig>(configPath) : null;
  const profileName = normalizeProfileName(options.profile ?? (current ? activeProfileName(current) : DEFAULT_PROFILE));
  let currentProfile: ReturnType<typeof collectorProfile> | null = null;
  if (current) {
    try {
      currentProfile = collectorProfile(current, profileName);
    } catch {
      currentProfile = null;
    }
  }
  const providedApiKey = options.apiKeyStdin
    ? await readStdinSecret()
    : (options.apiKey ?? (profileName === DEFAULT_PROFILE ? current?.apiKey : undefined) ?? process.env.TRAICE_API_KEY);
  let credential = currentProfile?.credential;
  let credentialWarning: string | undefined;
  if (providedApiKey) {
    const stored = await storeCollectorCredential(configPath, providedApiKey, options.credentialStore, {}, profileName);
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

  const serverUrl = normalizeUrl(
    options.serverUrl ?? currentProfile?.serverUrl ?? current?.serverUrl ?? DEFAULT_SERVER_URL,
  );
  let next = mergeConfigForAgent(current, options.agent, {
    ...(profileName === DEFAULT_PROFILE
      ? {
          serverUrl,
          credential,
          ...(providedApiKey ? { authorization: undefined } : {}),
        }
      : {}),
    listenHost,
    listenPort,
    includePrompts,
    identity: {
      employeeEmail:
        options.employeeEmail ?? current?.identity.employeeEmail ?? currentProfile?.authorization?.userEmail,
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
  if (profileName !== DEFAULT_PROFILE) {
    next = upsertCollectorProfile(next, profileName, {
      serverUrl,
      credential,
      ...(providedApiKey ? {} : currentProfile?.authorization ? { authorization: currentProfile.authorization } : {}),
    });
  }
  if (options.profile) next.activeProfile = profileName;
  if (profileName === DEFAULT_PROFILE) delete next.apiKey;

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

  return {
    ok: true,
    agent: options.agent,
    profile: profileName,
    configPath,
    credential,
    ...(credentialWarning ? { credentialWarning } : {}),
    settings,
    nextCommand: `npx @traice/collector@latest collect --config ${configPath}`,
  };
}
