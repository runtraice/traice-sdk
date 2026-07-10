import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import {
  buildDefaultConfig,
  defaultSourceForAgent,
  mergeConfigForAgent,
  resolveConfigPath,
  writeCollectorConfig,
} from "./config";
import { normalizeUrl, parseMoney, parsePort, readJsonFile, readStdinSecret, resolveHome } from "./fs";
import { patchClaudeSettings, patchCodexConfig, type SettingsPatchResult } from "./settings";
import type { AgentName, CollectorConfig, CollectorInstallOptions } from "./types";

export interface InstallResult {
  ok: true;
  agent: AgentName;
  configPath: string;
  settings: SettingsPatchResult;
  nextCommand: string;
}

export async function installAgent(options: CollectorInstallOptions): Promise<InstallResult> {
  const configPath = resolveConfigPath(options.configPath);
  const current = existsSync(configPath) ? readJsonFile<CollectorConfig>(configPath) : null;
  const apiKey = options.apiKeyStdin
    ? await readStdinSecret()
    : (options.apiKey ?? current?.apiKey ?? process.env.TRAICE_API_KEY);
  const listenHost = options.listenHost ?? current?.listenHost ?? "127.0.0.1";
  const listenPort = parsePort(options.listenPort ?? current?.listenPort, 4318);
  const includePrompts = Boolean(options.includePrompts ?? current?.includePrompts ?? false);
  const now = new Date();
  const base = current ?? buildDefaultConfig(now);
  const agentHomePatch =
    options.agent === "claude-code"
      ? { claudeHome: resolveHome(options.claudeHome ?? base.claudeHome ?? "~/.claude") }
      : { codexHome: resolveHome(options.codexHome ?? base.codexHome ?? "~/.codex") };

  const next = mergeConfigForAgent(current, options.agent, {
    serverUrl: normalizeUrl(options.serverUrl ?? current?.serverUrl ?? "https://app.runtraice.com"),
    apiKey,
    listenHost,
    listenPort,
    includePrompts,
    identity: {
      employeeEmail: options.employeeEmail ?? current?.identity.employeeEmail,
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
    configPath,
    settings,
    nextCommand: `npx @traice/collector@latest collect --config ${configPath}`,
  };
}
