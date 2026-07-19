import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AgentName } from "./types";

const SERVICE_LABEL = "com.traice.collector";

export interface CollectorServiceResult {
  platform: NodeJS.Platform;
  status: "installed";
  definitionPath: string;
  nodePath: string;
  cliPath: string;
}

interface ServiceDependencies {
  platform?: NodeJS.Platform;
  home?: string;
  nodePath?: string;
  uid?: number;
  prepareRuntime?: () => { nodePath: string; cliPath: string };
  run?: (command: string, args: string[], ignoreFailure?: boolean) => void;
}

export function installCollectorService(
  options: { agent: AgentName; configPath: string; packageVersion: string },
  dependencies: ServiceDependencies = {},
): CollectorServiceResult {
  const platform = dependencies.platform ?? process.platform;
  const home = dependencies.home ?? homedir();
  const runtime = (dependencies.prepareRuntime ?? (() => prepareRuntime(home, options.packageVersion)))();
  const run = dependencies.run ?? runCommand;

  if (platform === "darwin") {
    const definitionPath = resolve(home, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
    const logsDir = resolve(home, ".traice/collector/logs");
    mkdirSync(dirname(definitionPath), { recursive: true });
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      definitionPath,
      launchAgentPlist({
        nodePath: runtime.nodePath,
        cliPath: runtime.cliPath,
        configPath: options.configPath,
        agent: options.agent,
        stdoutPath: resolve(logsDir, "collector.log"),
        stderrPath: resolve(logsDir, "collector.err"),
      }),
    );
    const domain = `gui/${dependencies.uid ?? process.getuid?.() ?? 0}`;
    run("launchctl", ["bootout", domain, definitionPath], true);
    run("launchctl", ["bootstrap", domain, definitionPath]);
    run("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`]);
    return { platform, status: "installed", definitionPath, ...runtime };
  }

  if (platform === "linux") {
    const definitionPath = resolve(home, ".config/systemd/user/traice-collector.service");
    mkdirSync(dirname(definitionPath), { recursive: true });
    writeFileSync(definitionPath, systemdUnit({ ...runtime, configPath: options.configPath, agent: options.agent }));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "traice-collector"]);
    return { platform, status: "installed", definitionPath, ...runtime };
  }

  if (platform === "win32") {
    const definitionPath = "Task Scheduler: trAIce Collector";
    const taskCommand = windowsCommand(runtime.nodePath, runtime.cliPath, options.configPath, options.agent);
    run("schtasks.exe", ["/Create", "/TN", "trAIce Collector", "/TR", taskCommand, "/SC", "ONLOGON", "/F"]);
    run("schtasks.exe", ["/Run", "/TN", "trAIce Collector"]);
    return { platform, status: "installed", definitionPath, ...runtime };
  }

  throw new Error(`Automatic background service setup is not supported on ${platform}.`);
}

function prepareRuntime(home: string, packageVersion: string): { nodePath: string; cliPath: string } {
  const runtimeRoot = resolve(home, ".traice/collector/runtime");
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error("Could not locate npm. Run setup through npx or npm exec.");
  }
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  runCommand(process.execPath, [
    npmCli,
    "install",
    "--no-audit",
    "--no-fund",
    "--prefix",
    runtimeRoot,
    `@traice/collector@${packageVersion}`,
  ]);
  return {
    nodePath: process.execPath,
    cliPath: resolve(runtimeRoot, "node_modules/@traice/collector/dist/cli.cjs"),
  };
}

function runCommand(command: string, args: string[], ignoreFailure = false): void {
  try {
    execFileSync(command, args, { stdio: ignoreFailure ? "ignore" : "inherit" });
  } catch (error) {
    if (!ignoreFailure) throw error;
  }
}

function launchAgentPlist(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
  agent: AgentName;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const args = [options.nodePath, options.cliPath, "collect", "--agent", options.agent, "--config", options.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map((value) => `<string>${xmlEscape(value)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(options.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(options.stderrPath)}</string>
</dict></plist>
`;
}

function systemdUnit(options: { nodePath: string; cliPath: string; configPath: string; agent: AgentName }): string {
  return `[Unit]
Description=trAIce collector
After=network-online.target

[Service]
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.cliPath)} collect --agent ${options.agent} --config ${systemdQuote(options.configPath)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function windowsCommand(nodePath: string, cliPath: string, configPath: string, agent: AgentName): string {
  return [nodePath, cliPath, "collect", "--agent", agent, "--config", configPath]
    .map((value) => `"${value.replaceAll('"', '\\"')}"`)
    .join(" ");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
