#!/usr/bin/env node
import { Command } from "commander";
import { backfillCodex, dryRunCodexBackfill } from "./backfill";
import { installAgent } from "./install";
import { runCollector } from "./run";
import type { AgentName } from "./types";

const program = new Command();

program.name("traice-collector").description("Collect local coding-agent usage for trAIce.").version("0.1.0");

program
  .command("install")
  .argument("<agent>", "agent to install: claude-code or codex")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL", "https://runtraice.com")
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
    if (!options.dryRun && !until) {
      throw new Error(
        "Actual backfill requires an exclusive --until boundary so it cannot overlap unbounded live collection.",
      );
    }
    const result = options.dryRun
      ? dryRunCodexBackfill({ codexHome: stringOption(options.codexHome), since, until })
      : await backfillCodex({
          configPath: stringOption(options.config),
          codexHome: stringOption(options.codexHome),
          since,
          until: until!,
          onProgress: ({ processed, total, accepted }) => {
            console.error(`[traice-collector] backfill ${processed}/${total}; accepted ${accepted}`);
          },
        });
    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
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

function credentialStoreOption(value: unknown): "auto" | "keyring" | "file" {
  if (value === "auto" || value === "keyring" || value === "file") return value;
  throw new Error(`Invalid credential store: ${String(value)}. Expected auto, keyring, or file.`);
}
