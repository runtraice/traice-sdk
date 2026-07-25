import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import packageMetadata from "../package.json";
import { loadCollectorConfig, resolveConfigPath } from "./config";
import { readCollectorCredential } from "./credentials";
import { allRoutedDestinationNames, configForDestination, normalizeDestinationName } from "./destinations";
import { collectorServiceDefinitionPath, installedCollectorServiceVersion } from "./service";
import { verifyCollectorConnection } from "./setup";
import type { AgentName, CollectorCredential } from "./types";

export type CollectorServiceState = "running" | "installed" | "stopped" | "not-installed" | "unknown";

export interface CollectorCredentialStatus {
  ok: boolean;
  backend?: CollectorCredential["backend"];
  message?: string;
}

export interface CollectorServerStatus {
  ok: boolean;
  url?: string;
  message?: string;
}

export interface CollectorDestinationStatus {
  name: string;
  ok: boolean;
  serverUrl: string;
  workspaceName?: string;
  userEmail?: string;
  credential: CollectorCredentialStatus;
  server: CollectorServerStatus;
}

export interface CollectorStatusResult {
  ok: boolean;
  config: {
    ok: boolean;
    path: string;
    serverUrl?: string;
    listenUrl?: string;
    agents?: AgentName[];
    destination?: string;
    message?: string;
  };
  destinations: CollectorDestinationStatus[];
  credential: CollectorCredentialStatus;
  service: {
    ok: boolean;
    platform: NodeJS.Platform;
    state: CollectorServiceState;
    definitionPath?: string;
    version?: string;
    expectedVersion?: string;
    message?: string;
  };
  listener: { ok: boolean; url?: string; message?: string };
  server: CollectorServerStatus;
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
  expectedVersion?: string;
  run?: (command: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}

export async function getCollectorStatus(
  options: { configPath?: string; timeoutMs?: number; destination?: string } = {},
  dependencies: StatusDependencies = {},
): Promise<CollectorStatusResult> {
  const configPath = resolveConfigPath(options.configPath);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const service = (dependencies.checkService ?? (() => getCollectorServiceStatus(dependencies)))();

  let rootConfig;
  try {
    rootConfig = loadCollectorConfig(configPath);
  } catch (error) {
    const message = errorMessage(error);
    return {
      ok: false,
      config: { ok: false, path: configPath, message },
      destinations: [],
      credential: { ok: false, message: "Skipped because the collector config could not be loaded." },
      service,
      listener: { ok: false, message: "Skipped because the collector config could not be loaded." },
      server: { ok: false, message: "Skipped because the collector config could not be loaded." },
    };
  }

  let destinationConfigs: Array<{ name: string; config: ReturnType<typeof configForDestination> }>;
  try {
    const destinationNames = options.destination
      ? [normalizeDestinationName(options.destination)]
      : allRoutedDestinationNames(rootConfig);
    destinationConfigs = destinationNames.map((name) => ({ name, config: configForDestination(rootConfig, name) }));
  } catch (error) {
    const message = errorMessage(error);
    return {
      ok: false,
      config: { ok: false, path: configPath, message },
      destinations: [],
      credential: { ok: false, message },
      service,
      listener: { ok: false, message: "Skipped because no destination could be selected." },
      server: { ok: false, message: "Skipped because no destination could be selected." },
    };
  }
  const listenUrl = `http://${displayHost(rootConfig.listenHost)}:${rootConfig.listenPort}`;
  const [listener, destinations] = await Promise.all([
    checkListener(listenUrl, timeoutMs, dependencies.fetchImpl),
    Promise.all(
      destinationConfigs.map(async ({ name, config }) => {
        const [credential, server] = await Promise.all([
          checkCredential(config.credential, config.apiKey),
          checkServer(configPath, config.serverUrl, timeoutMs, dependencies.fetchImpl, name),
        ]);
        return {
          name,
          ok: credential.ok && server.ok,
          serverUrl: config.serverUrl,
          ...(config.authorization?.workspaceName ? { workspaceName: config.authorization.workspaceName } : {}),
          ...(config.authorization?.userEmail ? { userEmail: config.authorization.userEmail } : {}),
          credential,
          server,
        };
      }),
    ),
  ]);
  const credential = aggregateCredentialStatus(destinations);
  const server = aggregateServerStatus(destinations);
  const singleDestination = destinations.length === 1 ? destinations[0] : undefined;

  return {
    ok: destinations.every((destination) => destination.ok) && service.ok && listener.ok,
    config: {
      ok: true,
      path: configPath,
      listenUrl,
      agents: rootConfig.enabledAgents,
      ...(singleDestination
        ? {
            serverUrl: singleDestination.serverUrl,
            destination: singleDestination.name,
          }
        : {}),
    },
    destinations,
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
  const expectedVersion = dependencies.expectedVersion ?? packageMetadata.version;
  const version = installedCollectorServiceVersion(dependencies);
  const versionMismatch = Boolean(version && version !== expectedVersion);

  if (platform === "darwin") {
    const definitionPath = collectorServiceDefinitionPath({ platform, home })!;
    const domain = `gui/${dependencies.uid ?? process.getuid?.() ?? 0}`;
    const result = run("launchctl", ["print", `${domain}/com.traice.collector`]);
    const state =
      result.status === 0 && /\bstate\s*=\s*running\b/.test(result.stdout)
        ? "running"
        : existsSync(definitionPath)
          ? "stopped"
          : "not-installed";
    return {
      ok: state === "running" && !versionMismatch,
      platform,
      state,
      definitionPath,
      ...(version ? { version, expectedVersion } : {}),
      ...(versionMismatch
        ? {
            message: `Background service ${version} does not match CLI ${expectedVersion}. Run "npx @traice/collector@latest update".`,
          }
        : state === "stopped"
          ? { message: "The LaunchAgent is installed but is not running." }
          : {}),
    };
  }

  if (platform === "linux") {
    const definitionPath = collectorServiceDefinitionPath({ platform, home })!;
    const result = run("systemctl", ["--user", "is-active", "traice-collector"]);
    const state =
      result.status === 0 && result.stdout.trim() === "active"
        ? "running"
        : existsSync(definitionPath)
          ? "stopped"
          : "not-installed";
    return {
      ok: state === "running" && !versionMismatch,
      platform,
      state,
      definitionPath,
      ...(version ? { version, expectedVersion } : {}),
      ...(versionMismatch
        ? {
            message: `Background service ${version} does not match CLI ${expectedVersion}. Run "npx @traice/collector@latest update".`,
          }
        : state === "stopped"
          ? { message: "The systemd user service is installed but is not running." }
          : {}),
    };
  }

  if (platform === "win32") {
    const definitionPath = collectorServiceDefinitionPath({
      platform,
      home,
      appData: dependencies.appData,
    })!;
    if (existsSync(definitionPath)) {
      return {
        ok: !versionMismatch,
        platform,
        state: "installed",
        definitionPath,
        ...(version ? { version, expectedVersion } : {}),
        ...(versionMismatch
          ? {
              message: `Background service ${version} does not match CLI ${expectedVersion}. Run "npx @traice/collector@latest update".`,
            }
          : {}),
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
  if (result.destinations.length > 1) {
    lines.push(`Destinations: ${result.destinations.length} checked`);
    for (const destination of result.destinations) {
      lines.push(`  ${destination.name}: ${checkLabel(destination.ok)}`);
      lines.push(`    Server: ${checkLabel(destination.server.ok)} ${destination.serverUrl}`);
      lines.push(
        `    Credential: ${checkLabel(destination.credential.ok)}${
          destination.credential.backend ? ` ${destination.credential.backend}` : ""
        }`,
      );
    }
  } else {
    if (result.config.serverUrl) lines.push(`Server: ${checkLabel(result.server.ok)} ${result.config.serverUrl}`);
    if (result.config.destination) lines.push(`Destination: ${result.config.destination}`);
  }
  if (result.config.listenUrl) lines.push(`Listener: ${checkLabel(result.listener.ok)} ${result.config.listenUrl}`);
  if (result.destinations.length <= 1) {
    lines.push(
      `Credential: ${checkLabel(result.credential.ok)}${
        result.credential.backend ? ` ${result.credential.backend}` : ""
      }`,
    );
  }
  lines.push(
    `Background service: ${checkLabel(result.service.ok)} ${result.service.state} (${result.service.platform})${
      result.service.version
        ? `, version ${result.service.version}${
            result.service.expectedVersion && result.service.expectedVersion !== result.service.version
              ? `; CLI ${result.service.expectedVersion}`
              : ""
          }`
        : ""
    }`,
  );
  if (result.config.agents)
    lines.push(`Agents: ${result.config.agents.length > 0 ? result.config.agents.join(", ") : "none"}`);

  const messages = new Set(
    [
      result.config,
      result.service,
      result.listener,
      ...(result.destinations.length === 0 ? [result.credential, result.server] : []),
    ]
      .map((check) => check.message)
      .filter((message): message is string => Boolean(message)),
  );
  for (const message of messages) {
    lines.push(`Issue: ${message}`);
  }
  for (const destination of result.destinations) {
    if (destination.credential.message) {
      lines.push(`Issue (${destination.name} credential): ${destination.credential.message}`);
    }
    if (destination.server.message) {
      lines.push(`Issue (${destination.name} server): ${destination.server.message}`);
    }
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
  destination?: string,
): Promise<CollectorStatusResult["server"]> {
  const timedFetch: typeof fetch = (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  try {
    await verifyCollectorConnection(configPath, timedFetch, destination);
    return { ok: true, url: serverUrl };
  } catch (error) {
    return { ok: false, url: serverUrl, message: errorMessage(error) };
  }
}

function aggregateCredentialStatus(destinations: CollectorDestinationStatus[]): CollectorCredentialStatus {
  if (destinations.length === 0) return { ok: false, message: "No routed destination was checked." };
  const backends = Array.from(
    new Set(
      destinations
        .map((destination) => destination.credential.backend)
        .filter((backend): backend is CollectorCredential["backend"] => Boolean(backend)),
    ),
  );
  return {
    ok: destinations.every((destination) => destination.credential.ok),
    ...(backends.length === 1 ? { backend: backends[0] } : {}),
  };
}

function aggregateServerStatus(destinations: CollectorDestinationStatus[]): CollectorServerStatus {
  if (destinations.length === 0) return { ok: false, message: "No routed destination was checked." };
  return {
    ok: destinations.every((destination) => destination.server.ok),
    ...(destinations.length === 1 ? { url: destinations[0]!.serverUrl } : {}),
  };
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
