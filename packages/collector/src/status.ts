import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadCollectorConfig, resolveConfigPath } from "./config";
import { readCollectorCredential } from "./credentials";
import { verifyCollectorConnection } from "./setup";
import type { AgentName, CollectorCredential } from "./types";

export type CollectorServiceState = "running" | "installed" | "stopped" | "not-installed" | "unknown";

export interface CollectorStatusResult {
  ok: boolean;
  config: {
    ok: boolean;
    path: string;
    serverUrl?: string;
    listenUrl?: string;
    agents?: AgentName[];
    message?: string;
  };
  credential: { ok: boolean; backend?: CollectorCredential["backend"]; message?: string };
  service: {
    ok: boolean;
    platform: NodeJS.Platform;
    state: CollectorServiceState;
    definitionPath?: string;
    message?: string;
  };
  listener: { ok: boolean; url?: string; message?: string };
  server: { ok: boolean; url?: string; message?: string };
}

interface StatusDependencies {
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  uid?: number;
  checkService?: () => CollectorStatusResult["service"];
}

interface ServiceStatusDependencies {
  platform?: NodeJS.Platform;
  home?: string;
  appData?: string;
  uid?: number;
  run?: (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}

export async function getCollectorStatus(
  options: { configPath?: string; timeoutMs?: number } = {},
  dependencies: StatusDependencies = {},
): Promise<CollectorStatusResult> {
  const configPath = resolveConfigPath(options.configPath);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const service = (dependencies.checkService ?? (() => getCollectorServiceStatus(dependencies)))();

  let config;
  try {
    config = loadCollectorConfig(configPath);
  } catch (error) {
    const message = errorMessage(error);
    return {
      ok: false,
      config: { ok: false, path: configPath, message },
      credential: { ok: false, message: "Skipped because the collector config could not be loaded." },
      service,
      listener: { ok: false, message: "Skipped because the collector config could not be loaded." },
      server: { ok: false, message: "Skipped because the collector config could not be loaded." },
    };
  }

  const listenUrl = `http://${displayHost(config.listenHost)}:${config.listenPort}`;
  const serverUrl = config.serverUrl;
  const credential = await checkCredential(config.credential, config.apiKey);
  const [listener, server] = await Promise.all([
    checkListener(listenUrl, timeoutMs, dependencies.fetchImpl),
    checkServer(configPath, serverUrl, timeoutMs, dependencies.fetchImpl),
  ]);

  return {
    ok: credential.ok && service.ok && listener.ok && server.ok,
    config: {
      ok: true,
      path: configPath,
      serverUrl,
      listenUrl,
      agents: config.enabledAgents,
    },
    credential,
    service,
    listener,
    server,
  };
}

export function getCollectorServiceStatus(
  dependencies: ServiceStatusDependencies = {},
): CollectorStatusResult["service"] {
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? homedir();
  const run = dependencies.run ?? runStatusCommand;

  if (platform === "darwin") {
    const definitionPath = resolve(home, "Library/LaunchAgents/com.traice.collector.plist");
    const domain = `gui/${dependencies.uid ?? process.getuid?.() ?? 0}`;
    const result = run("launchctl", ["print", `${domain}/com.traice.collector`]);
    const state =
      result.status === 0 && /\bstate\s*=\s*running\b/.test(result.stdout)
        ? "running"
        : existsSync(definitionPath)
          ? "stopped"
          : "not-installed";
    return {
      ok: state === "running",
      platform,
      state,
      definitionPath,
      ...(state === "stopped" ? { message: "The LaunchAgent is installed but is not running." } : {}),
    };
  }

  if (platform === "linux") {
    const definitionPath = resolve(home, ".config/systemd/user/traice-collector.service");
    const result = run("systemctl", ["--user", "is-active", "traice-collector"]);
    const state =
      result.status === 0 && result.stdout.trim() === "active"
        ? "running"
        : existsSync(definitionPath)
          ? "stopped"
          : "not-installed";
    return {
      ok: state === "running",
      platform,
      state,
      definitionPath,
      ...(state === "stopped" ? { message: "The systemd user service is installed but is not running." } : {}),
    };
  }

  if (platform === "win32") {
    const definitionPath = resolve(
      dependencies.appData ?? process.env.APPDATA ?? resolve(home, "AppData/Roaming"),
      "Microsoft/Windows/Start Menu/Programs/Startup/trAIce Collector.vbs",
    );
    if (existsSync(definitionPath)) {
      return {
        ok: true,
        platform,
        state: "installed",
        definitionPath,
      };
    }
    const result = run("schtasks.exe", ["/Query", "/TN", "trAIce Collector", "/FO", "LIST"]);
    const installed = result.status === 0;
    const state = !installed ? "not-installed" : /\bRunning\b/i.test(result.stdout) ? "running" : "installed";
    return {
      ok: installed,
      platform,
      state,
      definitionPath: installed ? "Task Scheduler: trAIce Collector" : definitionPath,
    };
  }

  return {
    ok: false,
    platform,
    state: "unknown",
    message: `Background service status is not supported on ${platform}.`,
  };
}

export function formatCollectorStatus(result: CollectorStatusResult): string {
  const lines = [
    `trAIce Collector: ${result.ok ? "healthy" : "needs attention"}`,
    `Config: ${checkLabel(result.config.ok)} ${result.config.path}`,
  ];
  if (result.config.serverUrl) lines.push(`Server: ${checkLabel(result.server.ok)} ${result.config.serverUrl}`);
  if (result.config.listenUrl) lines.push(`Listener: ${checkLabel(result.listener.ok)} ${result.config.listenUrl}`);
  lines.push(
    `Credential: ${checkLabel(result.credential.ok)}${result.credential.backend ? ` ${result.credential.backend}` : ""}`,
  );
  lines.push(
    `Background service: ${checkLabel(result.service.ok)} ${result.service.state} (${result.service.platform})`,
  );
  if (result.config.agents)
    lines.push(`Agents: ${result.config.agents.length > 0 ? result.config.agents.join(", ") : "none"}`);

  const messages = new Set(
    [result.config, result.credential, result.service, result.listener, result.server]
      .map((check) => check.message)
      .filter((message): message is string => Boolean(message)),
  );
  for (const message of messages) {
    lines.push(`Issue: ${message}`);
  }
  return lines.join("\n");
}

async function checkCredential(
  credential: CollectorCredential | undefined,
  legacyApiKey: string | undefined,
): Promise<CollectorStatusResult["credential"]> {
  if (legacyApiKey) return { ok: true, backend: undefined, message: "A legacy plaintext credential needs migration." };
  if (!credential) return { ok: false, message: "No saved collector credential was found." };
  try {
    const value = await readCollectorCredential(credential);
    return value
      ? { ok: true, backend: credential.backend }
      : { ok: false, backend: credential.backend, message: "The saved credential is empty." };
  } catch {
    return { ok: false, backend: credential.backend, message: "The saved credential could not be read." };
  }
}

async function checkListener(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CollectorStatusResult["listener"]> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = (await response.json().catch(() => null)) as { service?: unknown } | null;
    if (response.ok && body?.service === "traice-collector") return { ok: true, url };
    return {
      ok: false,
      url,
      message: `The local listener returned HTTP ${response.status} without a collector health response.`,
    };
  } catch {
    return { ok: false, url, message: "The local collector listener could not be reached." };
  }
}

async function checkServer(
  configPath: string,
  serverUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CollectorStatusResult["server"]> {
  const timedFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    await verifyCollectorConnection(configPath, timedFetch);
    return { ok: true, url: serverUrl };
  } catch (error) {
    return { ok: false, url: serverUrl, message: errorMessage(error) };
  }
}

function boundedTimeout(value = 3000): number {
  if (!Number.isInteger(value) || value < 250 || value > 30000) {
    throw new Error(`Invalid timeout: ${value}. Expected an integer from 250 to 30000 milliseconds.`);
  }
  return value;
}

function displayHost(host: string): string {
  return host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "[::1]" : host.includes(":") ? `[${host}]` : host;
}

function checkLabel(ok: boolean): string {
  return ok ? "ok" : "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runStatusCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
