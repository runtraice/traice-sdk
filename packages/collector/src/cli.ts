#!/usr/bin/env node
import { Command } from "commander";
import packageMetadata from "../package.json";
import { loginAndStoreCollectorAuthorization, logoutCollector } from "./auth";
import { backfillCodex, dryRunCodexBackfill } from "./backfill";
import { loadCollectorConfig } from "./config";
import { installAgent } from "./install";
import { resolveFirstRunSetupIdentity } from "./identity";
import { runCollector } from "./run";
import { setupAgent } from "./setup";
import { verifyCollectorConnection } from "./setup";
import { formatCollectorStatus, getCollectorStatus } from "./status";
import type { AgentName, CollectorOAuthAuthorization } from "./types";

const program = new Command();

program
  .name("traice-collector")
  .description("Collect local coding-agent usage for trAIce.")
  .version(packageMetadata.version)
  .showHelpAfterError("\nRun 'traice-collector help' for usage.")
  .showSuggestionAfterError(true)
  .addHelpText(
    "after",
    `
Examples:
  traice-collector setup codex --employee-email you@company.com --team-name Engineering
  traice-collector status
  traice-collector status --json
  traice-collector help setup`,
  );

const authCommand = program.command("auth").description("Manage browser authorization for the collector");

authCommand
  .command("login")
  .description("Authorize the collector in a browser and save the session securely")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--workspace <id>", "workspace to preselect in the browser")
  .option("--no-browser", "print the authorization link without opening a browser")
  .action(async (options: Record<string, unknown>) => {
    const result = await loginAndStoreCollectorAuthorization({
      configPath: stringOption(options.config),
      serverUrl: stringOption(options.serverUrl),
      credentialStore: credentialStoreOption(options.credentialStore),
      workspaceHint: stringOption(options.workspace),
      noBrowser: Boolean(options.browser === false),
    });
    console.log(`Authorized ${result.authorization.workspaceName}.`);
    if (result.authorization.userEmail) console.log(`Signed in as ${result.authorization.userEmail}.`);
    console.log(`Credential stored in ${result.credential.backend}.`);
    if (result.credentialWarning) console.error(`[traice-collector] ${result.credentialWarning}`);
  });

authCommand
  .command("status")
  .description("Show the saved browser authorization and verify it with trAIce")
  .option("--config <path>", "collector config path")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const configPath = stringOption(options.config);
    let authorization: CollectorOAuthAuthorization | null = null;
    let ok = false;
    let error: string | undefined;
    try {
      const config = loadCollectorConfig(configPath);
      authorization = config.authorization ?? null;
      await verifyCollectorConnection(configPath);
      ok = true;
    } catch (statusError) {
      error = statusError instanceof Error ? statusError.message : String(statusError);
    }
    const result = { ok, authorization, ...(error ? { error } : {}) };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!authorization) {
      console.log(ok ? "Connected with a workspace API key." : "No browser-authorized collector session is saved.");
      if (error) console.error(error);
    } else {
      console.log(`${ok ? "Connected" : "Not connected"} to ${authorization.workspaceName}.`);
      if (authorization.userEmail) console.log(`Authorized as ${authorization.userEmail}.`);
      if (error) console.error(error);
    }
    if (!ok) process.exitCode = 1;
  });

authCommand
  .command("logout")
  .description("Revoke the browser-authorized collector session and remove it locally")
  .option("--config <path>", "collector config path")
  .action(async (options: Record<string, unknown>) => {
    const result = await logoutCollector(stringOption(options.config));
    if (!result.removed) {
      console.log("No browser-authorized collector session was found.");
      return;
    }
    console.log("Removed the saved collector authorization.");
    if (!result.remoteRevoked) {
      console.error("The server session could not be revoked. Revoke it from trAIce API keys and collector sessions.");
    }
  });

program
  .command("status")
  .description("Check configuration, credentials, background service, listener, and server access")
  .option("--config <path>", "collector config path")
  .option("--timeout <milliseconds>", "network check timeout from 250 to 30000 milliseconds", "3000")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const result = await getCollectorStatus({
      configPath: stringOption(options.config),
      timeoutMs: integerOption(options.timeout, "timeout"),
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatCollectorStatus(result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("setup")
  .description("Securely configure an agent, validate access, run a bounded backfill, and start a background service")
  .argument("<agent>", "agent to set up: claude-code or codex")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL")
  .option("--api-key <key>", "trAIce API key")
  .option("--api-key-stdin", "read trAIce API key from stdin")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--workspace <id>", "workspace to preselect during browser authorization")
  .option("--no-browser", "print the authorization link without opening a browser")
  .option("--employee-email <email>", "employee email")
  .option("--employee-name <name>", "employee display name")
  .option("--employee-external-id <id>", "employee external ID")
  .option("--team-name <name>", "team display name")
  .option("--team-external-id <id>", "team external ID")
  .option("--source-principal <value>", "device/user source principal")
  .option("--seat-monthly-usd <amount>", "monthly agent seat commitment")
  .option("--listen-host <host>", "local OTLP host")
  .option("--listen-port <port>", "local OTLP port")
  .option("--include-prompts", "enable prompt logging where the agent supports it")
  .option("--claude-home <path>", "Claude Code home")
  .option("--codex-home <path>", "Codex home")
  .option("--backfill-days <days>", "Codex history window from 1 to 30 days", "7")
  .option("--no-backfill", "skip historical Codex usage")
  .option("--no-service", "skip background service installation")
  .option("--yes", "accept provided or inferred identity defaults without prompting")
  .action(async (agent: string, options: Record<string, unknown>) => {
    const identity = await resolveFirstRunSetupIdentity({
      configPath: stringOption(options.config),
      employeeEmail: stringOption(options.employeeEmail),
      teamName: stringOption(options.teamName),
      acceptDefaults: Boolean(options.yes),
    });
    const result = await setupAgent({
      agent: parseAgent(agent),
      configPath: stringOption(options.config),
      serverUrl: stringOption(options.serverUrl),
      apiKey: stringOption(options.apiKey),
      apiKeyStdin: Boolean(options.apiKeyStdin),
      credentialStore: credentialStoreOption(options.credentialStore),
      workspaceHint: stringOption(options.workspace),
      noBrowser: Boolean(options.browser === false),
      employeeEmail: identity.employeeEmail,
      employeeName: stringOption(options.employeeName),
      employeeExternalId: stringOption(options.employeeExternalId),
      teamName: identity.teamName,
      teamExternalId: stringOption(options.teamExternalId),
      sourcePrincipal: stringOption(options.sourcePrincipal),
      seatMonthlyUsd: numberOption(options.seatMonthlyUsd),
      listenHost: stringOption(options.listenHost),
      listenPort: numberOption(options.listenPort),
      includePrompts: Boolean(options.includePrompts),
      claudeHome: stringOption(options.claudeHome),
      codexHome: stringOption(options.codexHome),
      backfill: Boolean(options.backfill),
      backfillDays: numberOption(options.backfillDays),
      service: Boolean(options.service),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("install")
  .description("Configure one agent without installing a background service or running history backfill")
  .argument("<agent>", "agent to install: claude-code or codex")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL", "https://www.runtraice.com")
  .option("--api-key <key>", "trAIce API key")
  .option("--api-key-stdin", "read trAIce API key from stdin")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--employee-email <email>", "employee email")
  .option("--employee-name <name>", "employee display name")
  .option("--employee-external-id <id>", "employee external ID")
  .option("--team-name <name>", "team display name")
  .option("--team-external-id <id>", "team external ID")
  .option("--source-principal <value>", "device/user source principal")
  .option("--seat-monthly-usd <amount>", "monthly agent seat commitment")
  .option("--listen-host <host>", "local OTLP host", "127.0.0.1")
  .option("--listen-port <port>", "local OTLP port", "4318")
  .option("--include-prompts", "enable prompt logging where the agent supports it")
  .option("--patch-settings", "patch local agent settings")
  .option("--claude-home <path>", "Claude Code home", "~/.claude")
  .option("--codex-home <path>", "Codex home", "~/.codex")
  .action(async (agent: string, options: Record<string, unknown>) => {
    const result = await installAgent({
      agent: parseAgent(agent),
      configPath: stringOption(options.config),
      serverUrl: stringOption(options.serverUrl),
      apiKey: stringOption(options.apiKey),
      apiKeyStdin: Boolean(options.apiKeyStdin),
      credentialStore: credentialStoreOption(options.credentialStore),
      employeeEmail: stringOption(options.employeeEmail),
      employeeName: stringOption(options.employeeName),
      employeeExternalId: stringOption(options.employeeExternalId),
      teamName: stringOption(options.teamName),
      teamExternalId: stringOption(options.teamExternalId),
      sourcePrincipal: stringOption(options.sourcePrincipal),
      seatMonthlyUsd: numberOption(options.seatMonthlyUsd),
      listenHost: stringOption(options.listenHost),
      listenPort: numberOption(options.listenPort),
      includePrompts: Boolean(options.includePrompts),
      patchSettings: Boolean(options.patchSettings),
      claudeHome: stringOption(options.claudeHome),
      codexHome: stringOption(options.codexHome),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("collect")
  .description("Run the local OTLP listener and forward normalized usage to trAIce")
  .option("--config <path>", "collector config path")
  .option("--agent <agent>", "only normalize this agent")
  .option("--listen-host <host>", "override local OTLP host")
  .option("--listen-port <port>", "override local OTLP port")
  .action(async (options: Record<string, unknown>) => {
    await runCollector({
      configPath: stringOption(options.config),
      agent: options.agent ? parseAgent(String(options.agent)) : undefined,
      listenHost: stringOption(options.listenHost),
      listenPort: numberOption(options.listenPort),
    });
  });

program
  .command("backfill")
  .description("Inspect or upload a bounded window of Codex usage history")
  .argument("<agent>", "agent history to inspect; currently codex")
  .requiredOption("--since <date-or-duration>", "earliest event, for example 14d or 2026-07-01")
  .option("--until <date-or-duration>", "exclusive upper boundary; defaults to now")
  .option("--config <path>", "collector config path")
  .option("--codex-home <path>", "Codex home", "~/.codex")
  .option("--dry-run", "inspect local history without sending data")
  .action(async (agent: string, options: Record<string, unknown>) => {
    if (agent !== "codex") throw new Error(`Unsupported backfill agent "${agent}". Expected "codex".`);
    const since = stringOption(options.since);
    if (!since) throw new Error("Missing required option --since.");
    const until = stringOption(options.until);
    const result = options.dryRun
      ? dryRunCodexBackfill({ codexHome: stringOption(options.codexHome), since, until })
      : await backfillCodex({
          configPath: stringOption(options.config),
          codexHome: stringOption(options.codexHome),
          since,
          until,
          onProgress: ({ processed, total, accepted }) => {
            console.error(`[traice-collector] backfill ${processed}/${total}; accepted ${accepted}`);
          },
        });
    console.log(JSON.stringify(result, null, 2));
  });

const cliArguments = process.argv.length <= 2 ? [...process.argv, "help"] : process.argv;
program.parseAsync(cliArguments).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

function parseAgent(value: string): AgentName {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unsupported agent "${value}". Expected "claude-code" or "codex".`);
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${String(value)}`);
  return parsed;
}

function integerOption(value: unknown, name: string): number | undefined {
  const parsed = numberOption(value);
  if (parsed !== undefined && !Number.isInteger(parsed)) throw new Error(`Invalid ${name}: ${String(value)}.`);
  return parsed;
}

function credentialStoreOption(value: unknown): "auto" | "keyring" | "file" {
  if (value === "auto" || value === "keyring" || value === "file") return value;
  throw new Error(`Invalid credential store: ${String(value)}. Expected auto, keyring, or file.`);
}
