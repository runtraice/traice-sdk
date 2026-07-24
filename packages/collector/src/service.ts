import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
  appData?: string;
  nodePath?: string;
  uid?: number;
  prepareRuntime?: () => { nodePath: string; cliPath: string };
  run?: (command: string, args: string[], ignoreFailure?: boolean) => void;
}

export function installCollectorService(
  options: {
    /** @deprecated The collector service now discovers each source per OTLP request. */
    agent?: import("./types").AgentName;
    configPath: string;
    packageVersion: string;
  },
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
    writeFileSync(definitionPath, systemdUnit({ ...runtime, configPath: options.configPath }));
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "traice-collector"]);
    return { platform, status: "installed", definitionPath, ...runtime };
  }

  if (platform === "win32") {
    const serviceDir = resolve(home, ".traice/collector/service");
    const logsDir = resolve(home, ".traice/collector/logs");
    const commandPath = resolve(serviceDir, "traice-collector.cmd");
    const startupDir = resolve(
      dependencies.appData ?? process.env.APPDATA ?? resolve(home, "AppData/Roaming"),
      "Microsoft/Windows/Start Menu/Programs/Startup",
    );
    const definitionPath = resolve(startupDir, "trAIce Collector.vbs");
    mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    mkdirSync(startupDir, { recursive: true });
    writeFileSync(
      commandPath,
      windowsRestartScript({
        ...runtime,
        configPath: options.configPath,
        stdoutPath: resolve(logsDir, "collector.log"),
        stderrPath: resolve(logsDir, "collector.err"),
      }),
    );
    writeFileSync(definitionPath, windowsHiddenLauncher(commandPath));
    run("schtasks.exe", ["/End", "/TN", "trAIce Collector"], true);
    run("schtasks.exe", ["/Delete", "/TN", "trAIce Collector", "/F"], true);
    run("wscript.exe", [definitionPath]);
    return { platform, status: "installed", definitionPath, ...runtime };
  }

  throw new Error(`Automatic background service setup is not supported on ${platform}.`);
}

function prepareRuntime(home: string, packageVersion: string): { nodePath: string; cliPath: string } {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion)) {
    throw new Error(`Invalid collector package version "${packageVersion}".`);
  }
  const runtimeRoot = resolve(home, ".traice/collector/runtime/versions", packageVersion);
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
  stdoutPath: string;
  stderrPath: string;
}): string {
  const args = [options.nodePath, options.cliPath, "collect", "--config", options.configPath];
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

function systemdUnit(options: { nodePath: string; cliPath: string; configPath: string }): string {
  return `[Unit]
Description=trAIce collector
After=network-online.target

[Service]
ExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.cliPath)} collect --config ${systemdQuote(options.configPath)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function windowsRestartScript(options: {
  nodePath: string;
  cliPath: string;
  configPath: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const command = [options.nodePath, options.cliPath, "collect", "--config", options.configPath]
    .map(windowsBatchQuote)
    .join(" ");
  return `@echo off\r\n:restart\r\n${command} 1>>${windowsBatchQuote(options.stdoutPath)} 2>>${windowsBatchQuote(options.stderrPath)}\r\ntimeout /t 5 /nobreak >nul\r\ngoto restart\r\n`;
}

function windowsHiddenLauncher(commandPath: string): string {
  return `Set shell = CreateObject("WScript.Shell")\r\nshell.Run Chr(34) & "${commandPath.replaceAll('"', '""')}" & Chr(34), 0, False\r\n`;
}

function windowsBatchQuote(value: string): string {
  return `"${value.replaceAll("%", "%%")}"`;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
