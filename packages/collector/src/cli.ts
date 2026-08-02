#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Command } from "commander";
import packageMetadata from "../package.json";
import { loginAndStoreCollectorAuthorization, logoutCollector } from "./auth";
import { backfillCodex, dryRunCodexBackfill } from "./backfill";
import { loadCollectorConfig, resolveConfigPath, writeCollectorConfig } from "./config";
import {
  collectorDestination,
  collectorDestinationSummaries,
  collectorRouteSummaries,
  configuredDestinationNames,
  defaultDestinationName,
  formatCollectorRouteList,
  normalizeDestinationName,
  routedDestinationNames,
  setCollectorRoute,
} from "./destinations";
import { installAgent } from "./install";
import {
  chooseSetupAgents,
  chooseSetupDestinations,
  confirmSetupPlan,
  detectSupportedAgents,
  resolveFirstRunSetupIdentity,
} from "./identity";
import { runCollector } from "./run";
import { refreshCollectorServiceIfOutdated } from "./service";
import { setupAgent } from "./setup";
import { verifyCollectorConnection } from "./setup";
import { formatCollectorStatus, getCollectorStatus } from "./status";
import type { AgentName, CollectorOAuthAuthorization, CredentialStoreMode } from "./types";
import { checkCollectorUpdate, updateCollector } from "./updates";
import {
  clearCollectorDestinationContext,
  collectorDestinationContextSummary,
  parseContextLabels,
  resolveRepositoryLabel,
  updateCollectorDestinationContext,
} from "./context";
import type { CollectorContextPatch } from "./context";
import {
  BENCHMARK_STAGE_KINDS,
  BENCHMARK_VARIANTS,
  benchmarkComparison,
  buildBenchmarkReport,
  initializeBenchmark,
  recordBenchmarkStage,
  recordBenchmarkTask,
  uploadBenchmarkReport,
  type BenchmarkStageKind,
  type BenchmarkVariantKey,
} from "./benchmark";

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
  traice-collector setup
  traice-collector destination list
  traice-collector route list
  traice-collector status`,
  );

const authCommand = program.command("auth").description("Manage browser authorization for collector destinations");

authCommand
  .command("login")
  .description("Authorize one or more workspace destinations in a browser")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--workspace <workspace>", "workspace slug or ID to preselect in the browser")
  .option("--destination <name>", "name for a single workspace destination")
  .option("--no-browser", "print the authorization link without opening a browser")
  .action(async (options: Record<string, unknown>) => {
    const result = await loginAndStoreCollectorAuthorization({
      configPath: stringOption(options.config),
      serverUrl: stringOption(options.serverUrl),
      credentialStore: credentialStoreOption(options.credentialStore),
      workspaceHint: stringOption(options.workspace),
      destination: stringOption(options.destination),
      noBrowser: options.browser === false,
    });
    for (const destination of result.destinations) {
      console.log(`Connected ${destination.authorization.workspaceName} as destination "${destination.name}".`);
      if (destination.authorization.userEmail) console.log(`Signed in as ${destination.authorization.userEmail}.`);
      console.log(`Credential stored in ${destination.credential.backend}.`);
      if (destination.credentialWarning) console.error(`[traice-collector] ${destination.credentialWarning}`);
    }
    refreshOutdatedService(stringOption(options.config));
    console.log('Review delivery with "npx @traice/collector@latest route list".');
  });

authCommand
  .command("status")
  .description("Verify a saved browser authorization")
  .option("--config <path>", "collector config path")
  .option("--destination <name>", "destination to inspect")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const configPath = stringOption(options.config);
    let authorization: CollectorOAuthAuthorization | null = null;
    let destination = stringOption(options.destination);
    let ok = false;
    let error: string | undefined;
    try {
      const config = loadCollectorConfig(configPath);
      destination = normalizeDestinationName(
        destination ??
          defaultDestinationName(config, config.enabledAgents.length > 0 ? config.enabledAgents[0] : undefined),
      );
      authorization = collectorDestination(config, destination).authorization ?? null;
      await verifyCollectorConnection(configPath, fetch, destination);
      ok = true;
    } catch (statusError) {
      error = errorMessage(statusError);
    }
    const result = { ok, destination, authorization, ...(error ? { error } : {}) };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!authorization) {
      console.log(ok ? "Connected with a workspace API key." : "No browser-authorized destination was found.");
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
  .description("Revoke and remove one browser-authorized destination")
  .requiredOption("--destination <name>", "destination to revoke")
  .option("--config <path>", "collector config path")
  .action(async (options: Record<string, unknown>) => {
    const destination = requiredStringOption(options.destination, "destination");
    const result = await logoutCollector(stringOption(options.config), fetch, destination);
    if (!result.removed) {
      console.log(`No browser-authorized destination named "${destination}" was found.`);
      return;
    }
    console.log(`Removed destination "${destination}".`);
    if (!result.remoteRevoked) {
      console.error("The server grant could not be revoked. You can revoke it from Connected collectors in trAIce.");
    }
    refreshOutdatedService(stringOption(options.config));
  });

program
  .command("setup")
  .description("Detect agents, authorize destinations, configure routes, and start the background service")
  .option("--config <path>", "collector config path")
  .option("--agent <agent>", "agent to configure; repeat to select more than one", collectValues, [])
  .option("--destination <name>", "destination to use; repeat to select more than one", collectValues, [])
  .option("--server-url <url>", "trAIce app URL")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--workspace <workspace>", "workspace slug or ID to preselect during authorization")
  .option("--no-browser", "print the authorization link without opening a browser")
  .option("--employee-email <email>", "employee email")
  .option("--employee-name <name>", "employee display name")
  .option("--team-name <name>", "team display name")
  .option("--seat-monthly-usd <amount>", "optional monthly agent seat commitment")
  .option("--listen-host <host>", "local OTLP host")
  .option("--listen-port <port>", "local OTLP port")
  .option("--include-prompts", "enable prompt logging where the agent supports it")
  .option("--claude-home <path>", "Claude Code home")
  .option("--codex-home <path>", "Codex home")
  .option("--backfill-days <days>", "offer an optional Codex history import from 1 to 30 days")
  .option("--no-service", "skip background service installation")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const configPath = stringOption(options.config);
    const requestedAgents = stringArrayOption(options.agent)?.map(parseAgent);
    const requestedDestinations = stringArrayOption(options.destination);
    const detected = detectSupportedAgents({
      configPath,
      claudeHome: stringOption(options.claudeHome),
      codexHome: stringOption(options.codexHome),
    });
    const agents = await chooseSetupAgents(detected, requestedAgents);
    let config = loadOptionalConfig(configPath);
    const missingRequestedDestination =
      requestedDestinations?.some((destination) => !config?.destinations[normalizeDestinationName(destination)]) ??
      false;
    if (!config || configuredDestinationNames(config).length === 0 || missingRequestedDestination) {
      const login = await loginAndStoreCollectorAuthorization({
        configPath,
        serverUrl: stringOption(options.serverUrl),
        credentialStore: credentialStoreOption(options.credentialStore),
        noBrowser: options.browser === false,
        destination: requestedDestinations?.length === 1 ? requestedDestinations[0] : undefined,
        workspaceHint: stringOption(options.workspace),
      });
      if (login.destinations.length === 0) throw new Error("Authorization did not add any workspace destinations.");
      config = loadCollectorConfig(configPath);
    }
    const selectedDestinations = await chooseSetupDestinations(
      collectorDestinationSummaries(config),
      requestedDestinations,
    );
    for (const destination of selectedDestinations) {
      await verifyCollectorConnection(configPath, fetch, destination);
    }

    const identity = await resolveFirstRunSetupIdentity({
      configPath,
      employeeEmail: stringOption(options.employeeEmail) ?? config.identity.employeeEmail,
      teamName: stringOption(options.teamName) ?? config.identity.teamName,
    });
    const backfillDays = numberOption(options.backfillDays);
    const approval = await confirmSetupPlan({
      agents,
      destinations: selectedDestinations,
      service: options.service !== false,
      ...(backfillDays === undefined ? {} : { backfillDays }),
    });
    config = updateConfig(configPath, (current) => {
      let next = current;
      for (const agent of agents) next = setCollectorRoute(next, agent, selectedDestinations);
      return next;
    });
    const results = [];
    for (const [index, agent] of agents.entries()) {
      results.push(
        await setupAgent({
          agent,
          destination: selectedDestinations[0],
          configPath,
          employeeEmail: identity.employeeEmail,
          employeeName: stringOption(options.employeeName),
          teamName: identity.teamName,
          seatMonthlyUsd: numberOption(options.seatMonthlyUsd),
          listenHost: stringOption(options.listenHost),
          listenPort: numberOption(options.listenPort),
          includePrompts: Boolean(options.includePrompts),
          claudeHome: stringOption(options.claudeHome),
          codexHome: stringOption(options.codexHome),
          patchSettings: true,
          service: approval.service && index === agents.length - 1,
          backfill: agent === "codex" && approval.backfill,
          backfillDays,
        }),
      );
    }
    console.log(options.json ? JSON.stringify(results, null, 2) : formatSetupResults(results));
  });

program
  .command("install")
  .description("Advanced: configure one agent without installing a background service")
  .argument("<agent>", "agent to install: claude-code or codex")
  .option("--config <path>", "collector config path")
  .option("--server-url <url>", "trAIce app URL")
  .option("--api-key <key>", "trAIce API key")
  .option("--api-key-stdin", "read trAIce API key from stdin")
  .option("--credential-store <mode>", "credential storage: auto, keyring, or file", "auto")
  .option("--destination <name>", "workspace destination")
  .option("--employee-email <email>", "employee email")
  .option("--employee-name <name>", "employee display name")
  .option("--team-name <name>", "team display name")
  .option("--seat-monthly-usd <amount>", "optional monthly agent seat commitment")
  .option("--listen-host <host>", "local OTLP host")
  .option("--listen-port <port>", "local OTLP port")
  .option("--include-prompts", "enable prompt logging where the agent supports it")
  .option("--patch-settings", "patch local agent settings")
  .option("--claude-home <path>", "Claude Code home")
  .option("--codex-home <path>", "Codex home")
  .option("--json", "print machine-readable JSON")
  .action(async (agent: string, options: Record<string, unknown>) => {
    const result = await installAgent({
      agent: parseAgent(agent),
      configPath: stringOption(options.config),
      serverUrl: stringOption(options.serverUrl),
      apiKey: stringOption(options.apiKey),
      apiKeyStdin: Boolean(options.apiKeyStdin),
      credentialStore: credentialStoreOption(options.credentialStore),
      destination: stringOption(options.destination),
      employeeEmail: stringOption(options.employeeEmail),
      employeeName: stringOption(options.employeeName),
      teamName: stringOption(options.teamName),
      seatMonthlyUsd: numberOption(options.seatMonthlyUsd),
      listenHost: stringOption(options.listenHost),
      listenPort: numberOption(options.listenPort),
      includePrompts: Boolean(options.includePrompts),
      patchSettings: Boolean(options.patchSettings),
      claudeHome: stringOption(options.claudeHome),
      codexHome: stringOption(options.codexHome),
    });
    refreshOutdatedService(result.configPath, !options.json);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatInstallResult(result));
  });

program
  .command("collect")
  .description("Run the local OTLP listener and forward normalized usage to configured routes")
  .option("--config <path>", "collector config path")
  .option("--agent <agent>", "only normalize this agent")
  .option("--listen-host <host>", "override local OTLP host")
  .option("--listen-port <port>", "override local OTLP port")
  .option("--destination <name>", "override destinations for this run; repeat for more than one", collectValues, [])
  .action(async (options: Record<string, unknown>) => {
    await runCollector({
      configPath: stringOption(options.config),
      agent: options.agent ? parseAgent(String(options.agent)) : undefined,
      listenHost: stringOption(options.listenHost),
      listenPort: numberOption(options.listenPort),
      destinations: stringArrayOption(options.destination),
    });
  });

program
  .command("backfill")
  .description("Inspect or upload a bounded window of Codex usage history")
  .argument("<agent>", "agent history to inspect; currently codex")
  .requiredOption("--since <date-or-duration>", "earliest event, for example 14d or 2026-07-01")
  .option("--until <date-or-duration>", "exclusive upper boundary; defaults to now")
  .option("--config <path>", "collector config path")
  .option("--destination <name>", "destination that receives the backfill")
  .option("--codex-home <path>", "Codex home")
  .option("--dry-run", "inspect local history without sending data")
  .option("--json", "print machine-readable JSON")
  .action(async (agent: string, options: Record<string, unknown>) => {
    if (agent !== "codex") throw new Error(`Unsupported backfill agent "${agent}". Expected "codex".`);
    const since = requiredStringOption(options.since, "since");
    const until = stringOption(options.until);
    const result = options.dryRun
      ? dryRunCodexBackfill({ codexHome: stringOption(options.codexHome), since, until })
      : await backfillCodex({
          configPath: stringOption(options.config),
          destination: stringOption(options.destination),
          codexHome: stringOption(options.codexHome),
          since,
          until,
          onProgress: ({ processed, total, accepted }) => {
            console.error(`[traice-collector] backfill ${processed}/${total}; accepted ${accepted}`);
          },
        });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatBackfillResult(result));
  });

program
  .command("status")
  .description("Check configuration, routed destinations, service, listener, and server access")
  .option("--config <path>", "collector config path")
  .option("--destination <name>", "destination to check")
  .option("--timeout <milliseconds>", "network check timeout from 250 to 30000 milliseconds", "3000")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const result = await getCollectorStatus({
      configPath: stringOption(options.config),
      destination: stringOption(options.destination),
      timeoutMs: integerOption(options.timeout, "timeout"),
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatCollectorStatus(result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("update")
  .description("Check for or install the latest stable collector service")
  .option("--config <path>", "collector config path")
  .option("--check", "check without installing")
  .option("--version <version>", "install an exact collector version")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const result = options.check
      ? await checkCollectorUpdate()
      : await updateCollector({
          configPath: stringOption(options.config),
          targetVersion: stringOption(options.version),
        });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if ("service" in result && result.service) {
      console.log(`Collector service installed at ${result.latestVersion}.`);
      console.log("Background service restarted.");
    } else if (!result.updateAvailable) console.log(`Collector ${result.currentVersion} is up to date.`);
    else console.log(`Collector ${result.latestVersion} is available. Run "npx @traice/collector@latest update".`);
  });

const destinationCommand = program.command("destination").description("Manage authorized workspace destinations");

destinationCommand
  .command("list")
  .description("List destinations grouped by trAIce account")
  .option("--config <path>", "collector config path")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const summaries = collectorDestinationSummaries(loadCollectorConfig(stringOption(options.config)));
    if (options.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }
    if (summaries.length === 0) {
      console.log('No destinations configured. Run "npx @traice/collector@latest setup".');
      return;
    }
    const groups = new Map<string, typeof summaries>();
    for (const destination of summaries) {
      const key = `${destination.serverUrl}\0${destination.userEmail ?? ""}`;
      groups.set(key, [...(groups.get(key) ?? []), destination]);
    }
    for (const destinations of groups.values()) {
      const first = destinations[0]!;
      console.log(`\n${first.serverUrl}${first.userEmail ? ` (${first.userEmail})` : ""}`);
      for (const destination of destinations) {
        console.log(
          `  ${destination.name}: ${destination.workspaceName ?? destination.workspaceId ?? "API key workspace"}`,
        );
      }
    }
  });

const routeCommand = program.command("route").description("Route each agent to one or more destinations");

routeCommand
  .command("list")
  .description("Show readable agent-to-workspace routes")
  .option("--config <path>", "collector config path")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const config = loadCollectorConfig(stringOption(options.config));
    if (options.json) console.log(JSON.stringify(collectorRouteSummaries(config), null, 2));
    else console.log(formatCollectorRouteList(config));
  });

routeCommand
  .command("set")
  .description("Replace the destinations for one agent")
  .argument("<agent>", "agent to route: claude-code or codex")
  .argument("<destinations...>", "one or more destination names")
  .option("--config <path>", "collector config path")
  .action((agent: string, destinations: string[], options: Record<string, unknown>) => {
    const parsedAgent = parseAgent(agent);
    updateConfig(stringOption(options.config), (config) => setCollectorRoute(config, parsedAgent, destinations));
    refreshOutdatedService(stringOption(options.config));
    console.log(`${parsedAgent} will send live usage to ${destinations.map(normalizeDestinationName).join(", ")}.`);
  });

const contextCommand = program
  .command("context")
  .description("Manage explicit, destination-scoped attribution and task context");

contextCommand
  .command("show")
  .description("Show the effective identity and opted-in context for one destination")
  .requiredOption("--destination <name>", "workspace destination")
  .option("--config <path>", "collector config path")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const summary = collectorDestinationContextSummary(
      loadCollectorConfig(stringOption(options.config)),
      requiredStringOption(options.destination, "destination"),
    );
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else console.log(formatCollectorContext(summary));
  });

const benchmarkCommand = program
  .command("benchmark")
  .description("Create, measure, compare, and upload reproducible repository benchmarks");

benchmarkCommand
  .command("init")
  .description("Create a private local A/B benchmark manifest")
  .requiredOption("--title <title>", "benchmark title")
  .requiredOption("--summary <summary>", "benchmark summary")
  .requiredOption("--prompt <prompt>", "benchmark prompt; repeat for multiple tasks", collectValues, [])
  .option("--path <path>", "manifest path")
  .option("--repository-url <url>", "public GitHub repository; defaults to origin")
  .option("--repository-revision <revision>", "pinned revision; defaults to HEAD")
  .option("--methodology-version <version>", "benchmark protocol version", "repo-context-v1")
  .option("--amortization-task-count <count>", "tasks used to amortize one-time setup")
  .option("--baseline-label <label>", "baseline display name", "Baseline")
  .option("--baseline-tool <tool>", "baseline tool name", "Coding agent")
  .option("--baseline-configuration <text>", "baseline configuration", "No candidate tool enabled.")
  .option("--candidate-label <label>", "candidate display name", "Candidate")
  .option("--candidate-tool <tool>", "candidate tool name", "Coding agent with candidate tool")
  .option("--candidate-configuration <text>", "candidate configuration", "Candidate tool enabled.")
  .option("--disclosure <text>", "public disclosure; repeat for more", collectValues, [])
  .option("--force", "replace an existing manifest")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const result = initializeBenchmark({
      path: stringOption(options.path),
      force: Boolean(options.force),
      title: requiredStringOption(options.title, "title"),
      summary: requiredStringOption(options.summary, "summary"),
      repositoryUrl: stringOption(options.repositoryUrl),
      repositoryRevision: stringOption(options.repositoryRevision),
      methodologyVersion: stringOption(options.methodologyVersion),
      amortizationTaskCount: integerOption(options.amortizationTaskCount, "amortization-task-count"),
      prompts: stringArrayOption(options.prompt) ?? [],
      baselineLabel: stringOption(options.baselineLabel),
      baselineTool: stringOption(options.baselineTool),
      baselineConfiguration: stringOption(options.baselineConfiguration),
      candidateLabel: stringOption(options.candidateLabel),
      candidateTool: stringOption(options.candidateTool),
      candidateConfiguration: stringOption(options.candidateConfiguration),
      disclosures: stringArrayOption(options.disclosure),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Created private benchmark manifest at ${result.path}.`);
      console.log(`Pinned ${result.manifest.repository.url} at ${result.manifest.repository.revision}.`);
      console.log('Sign in before upload with "npx @traice/collector@latest auth login".');
    }
  });

benchmarkCommand
  .command("stage")
  .description("Record setup, refresh, execution, or verification overhead")
  .requiredOption("--variant <variant>", "baseline or candidate")
  .requiredOption("--kind <kind>", "setup, refresh, execute, or verify")
  .requiredOption("--label <label>", "stage label")
  .requiredOption("--duration-ms <milliseconds>", "stage wall-clock duration")
  .option("--path <path>", "manifest path")
  .option("--input-tokens <tokens>", "stage input tokens", "0")
  .option("--output-tokens <tokens>", "stage output tokens", "0")
  .option("--cost-usd-micros <micros>", "stage cost in millionths of a USD", "0")
  .option("--status <status>", "completed, failed, or skipped", "completed")
  .option("--command <command>", "public command summary")
  .option("--source-revision <revision>", "revision or dirty-tree fingerprint")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const result = recordBenchmarkStage({
      path: stringOption(options.path),
      variant: benchmarkVariantOption(options.variant),
      kind: benchmarkStageKindOption(options.kind),
      label: requiredStringOption(options.label, "label"),
      durationMs: requiredIntegerOption(options.durationMs, "duration-ms"),
      inputTokens: integerOption(options.inputTokens, "input-tokens"),
      outputTokens: integerOption(options.outputTokens, "output-tokens"),
      costUsdMicros: integerOption(options.costUsdMicros, "cost-usd-micros"),
      status: stringOption(options.status) as "completed" | "failed" | "skipped" | undefined,
      command: stringOption(options.command),
      sourceRevision: stringOption(options.sourceRevision),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Recorded ${String(options.kind)} stage for ${String(options.variant)}.`);
  });

benchmarkCommand
  .command("task")
  .description("Record one task result without storing raw agent output")
  .requiredOption("--variant <variant>", "baseline or candidate")
  .requiredOption("--id <id>", "stable task ID shared by both variants")
  .requiredOption("--title <title>", "task title shared by both variants")
  .requiredOption("--input-tokens <tokens>", "task input tokens")
  .requiredOption("--output-tokens <tokens>", "task output tokens")
  .requiredOption("--cost-usd-micros <micros>", "task cost in millionths of a USD")
  .requiredOption("--duration-ms <milliseconds>", "task wall-clock duration")
  .option("--path <path>", "manifest path")
  .option("--cache-read-tokens <tokens>", "cached input tokens", "0")
  .option("--billable-tokens <tokens>", "provider-equivalent billable tokens")
  .option("--retries <count>", "task retries", "0")
  .option("--quality-score <score>", "quality or completion score from 0 to 100")
  .option("--status <status>", "completed, failed, or error", "completed")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const result = recordBenchmarkTask({
      path: stringOption(options.path),
      variant: benchmarkVariantOption(options.variant),
      id: requiredStringOption(options.id, "id"),
      title: requiredStringOption(options.title, "title"),
      inputTokens: requiredIntegerOption(options.inputTokens, "input-tokens"),
      cacheReadTokens: integerOption(options.cacheReadTokens, "cache-read-tokens"),
      outputTokens: requiredIntegerOption(options.outputTokens, "output-tokens"),
      billableTokens: integerOption(options.billableTokens, "billable-tokens"),
      costUsdMicros: requiredIntegerOption(options.costUsdMicros, "cost-usd-micros"),
      durationMs: requiredIntegerOption(options.durationMs, "duration-ms"),
      retries: integerOption(options.retries, "retries"),
      qualityScore: numberOption(options.qualityScore),
      status: stringOption(options.status) as "completed" | "failed" | "error" | undefined,
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`Recorded task "${String(options.id)}" for ${String(options.variant)}.`);
  });

benchmarkCommand
  .command("compare")
  .description("Validate parity and show the local A/B report")
  .option("--path <path>", "manifest path")
  .option("--json", "print the complete report and comparison as JSON")
  .action((options: Record<string, unknown>) => {
    const report = buildBenchmarkReport(stringOption(options.path));
    const comparison = benchmarkComparison(report);
    if (options.json) console.log(JSON.stringify({ report, comparison }, null, 2));
    else console.log(formatBenchmarkComparison(report, comparison));
  });

benchmarkCommand
  .command("upload")
  .description("Upload a validated private draft for owner or admin review")
  .option("--path <path>", "manifest path")
  .option("--config <path>", "collector config path")
  .option("--destination <name>", "authorized workspace destination")
  .option("--json", "print machine-readable JSON")
  .action(async (options: Record<string, unknown>) => {
    const result = await uploadBenchmarkReport({
      path: stringOption(options.path),
      configPath: stringOption(options.config),
      destination: stringOption(options.destination),
    });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      const benchmark = result.benchmark as { reviewPath?: string } | undefined;
      console.log("Uploaded a private benchmark draft.");
      if (benchmark?.reviewPath) console.log(`Review and publish it at ${benchmark.reviewPath}.`);
    }
  });

contextCommand
  .command("set")
  .description("Opt in to bounded identity and task context for one destination")
  .requiredOption("--destination <name>", "workspace destination")
  .option("--config <path>", "collector config path")
  .option("--employee-email <email>", "destination-specific employee email")
  .option("--employee-name <name>", "destination-specific employee display name")
  .option("--team-name <name>", "destination-specific team display name")
  .option("--clear-team", "leave this destination's team unset")
  .option("--source-principal <principal>", "destination-specific source principal")
  .option("--role <role>", "employee role, up to 80 characters")
  .option("--department <department>", "employee department, up to 80 characters")
  .option("--description <description>", "task description, up to 280 characters")
  .option("--repository <name>", 'repository label, or "auto" to infer the current Git remote')
  .option("--labels-json <object>", "bounded JSON object with task labels")
  .option("--json", "print machine-readable JSON")
  .action((options: Record<string, unknown>) => {
    const configPath = stringOption(options.config);
    const destination = requiredStringOption(options.destination, "destination");
    const patch = collectorContextPatchFromOptions(options);
    if (!patch.identity && !patch.context) {
      throw new Error("Set at least one identity or context option.");
    }
    const config = updateConfig(configPath, (current) =>
      updateCollectorDestinationContext(current, destination, patch),
    );
    refreshOutdatedService(configPath);
    const summary = collectorDestinationContextSummary(config, destination);
    if (options.json) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`Saved opt-in context for destination "${normalizeDestinationName(destination)}".`);
      console.log(formatCollectorContext(summary));
    }
  });

contextCommand
  .command("clear")
  .description("Clear opted-in task context for one destination")
  .requiredOption("--destination <name>", "workspace destination")
  .option("--config <path>", "collector config path")
  .option("--identity", "also clear destination-specific identity overrides")
  .action((options: Record<string, unknown>) => {
    const configPath = stringOption(options.config);
    const destination = requiredStringOption(options.destination, "destination");
    updateConfig(configPath, (current) =>
      clearCollectorDestinationContext(current, destination, Boolean(options.identity)),
    );
    refreshOutdatedService(configPath);
    console.log(
      `Cleared task context for destination "${normalizeDestinationName(destination)}"${
        options.identity ? " and restored the global identity" : ""
      }.`,
    );
  });

const cliArguments = process.argv.length <= 2 ? [...process.argv, "help"] : process.argv;
program.parseAsync(cliArguments).catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});

function parseAgent(value: string): AgentName {
  if (value === "claude-code" || value === "codex") return value;
  throw new Error(`Unsupported agent "${value}". Expected "claude-code" or "codex".`);
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStringOption(value: unknown, name: string): string {
  const parsed = stringOption(value);
  if (!parsed) throw new Error(`Missing required option --${name}.`);
  return parsed;
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

function requiredIntegerOption(value: unknown, name: string): number {
  const parsed = integerOption(value, name);
  if (parsed === undefined) throw new Error(`Missing required option --${name}.`);
  return parsed;
}

function benchmarkVariantOption(value: unknown): BenchmarkVariantKey {
  if (typeof value === "string" && BENCHMARK_VARIANTS.includes(value as BenchmarkVariantKey)) {
    return value as BenchmarkVariantKey;
  }
  throw new Error('Invalid benchmark variant. Expected "baseline" or "candidate".');
}

function benchmarkStageKindOption(value: unknown): BenchmarkStageKind {
  if (typeof value === "string" && BENCHMARK_STAGE_KINDS.includes(value as BenchmarkStageKind)) {
    return value as BenchmarkStageKind;
  }
  throw new Error("Invalid benchmark stage kind. Expected setup, refresh, execute, or verify.");
}

function credentialStoreOption(value: unknown): CredentialStoreMode {
  if (value === "auto" || value === "keyring" || value === "file") return value;
  throw new Error(`Invalid credential store: ${String(value)}. Expected auto, keyring, or file.`);
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectorContextPatchFromOptions(options: Record<string, unknown>): CollectorContextPatch {
  const employeeEmail = stringOption(options.employeeEmail);
  const employeeName = stringOption(options.employeeName);
  const teamName = stringOption(options.teamName);
  const clearTeam = Boolean(options.clearTeam);
  if (teamName && clearTeam) throw new Error("Use either --team-name or --clear-team, not both.");
  const sourcePrincipal = stringOption(options.sourcePrincipal);
  const role = stringOption(options.role);
  const department = stringOption(options.department);
  const description = stringOption(options.description);
  const requestedRepository = stringOption(options.repository);
  const repository = requestedRepository?.toLowerCase() === "auto" ? resolveRepositoryLabel() : requestedRepository;
  const labelsJson = stringOption(options.labelsJson);
  const identity =
    employeeEmail || employeeName || teamName || clearTeam || sourcePrincipal
      ? {
          ...(employeeEmail ? { employeeEmail } : {}),
          ...(employeeName ? { employeeName } : {}),
          ...(clearTeam ? { teamName: null } : teamName ? { teamName } : {}),
          ...(sourcePrincipal ? { sourcePrincipal } : {}),
        }
      : undefined;
  const context =
    role || department || description || repository || labelsJson
      ? {
          ...(role ? { role } : {}),
          ...(department ? { department } : {}),
          ...(description ? { description } : {}),
          ...(repository ? { repository } : {}),
          ...(labelsJson ? { labels: parseContextLabels(labelsJson) } : {}),
        }
      : undefined;
  return { ...(identity ? { identity } : {}), ...(context ? { context } : {}) };
}

function formatCollectorContext(summary: ReturnType<typeof collectorDestinationContextSummary>): string {
  const identity = summary.identity;
  const context = summary.context;
  return [
    `Destination: ${summary.destination}`,
    `Employee: ${identity.employeeEmail ?? identity.employeeName ?? "not set"}`,
    `Team: ${identity.teamName ?? "not set"}`,
    `Source principal: ${identity.sourcePrincipal ?? "not set"}`,
    `Seat commitment: ${identity.seatMonthlyUsd === undefined ? "not set" : `$${identity.seatMonthlyUsd}/month`}`,
    `Role: ${context.role ?? "not collected"}`,
    `Department: ${context.department ?? "not collected"}`,
    `Description: ${context.description ?? "not collected"}`,
    `Repository: ${context.repository ?? "not collected"}`,
    `Labels: ${context.labels ? JSON.stringify(context.labels) : "not collected"}`,
  ].join("\n");
}

function stringArrayOption(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return values.length > 0 ? values : undefined;
}

function loadOptionalConfig(configPath?: string) {
  const resolved = resolveConfigPath(configPath);
  return existsSync(resolved) ? loadCollectorConfig(resolved) : null;
}

function updateConfig(
  configPath: string | undefined,
  update: (config: ReturnType<typeof loadCollectorConfig>) => ReturnType<typeof loadCollectorConfig>,
) {
  const resolved = resolveConfigPath(configPath);
  const config = update(loadCollectorConfig(resolved));
  config.updatedAt = new Date().toISOString();
  writeCollectorConfig(config, resolved);
  return config;
}

function refreshOutdatedService(configPath?: string, report = true) {
  const service = refreshCollectorServiceIfOutdated({
    configPath: resolveConfigPath(configPath),
    packageVersion: packageMetadata.version,
  });
  if (service && report) {
    console.log(`Background service updated to ${packageMetadata.version} and restarted.`);
  }
  return service;
}

function formatSetupResults(results: Array<Awaited<ReturnType<typeof setupAgent>>>): string {
  const config = loadCollectorConfig(results[0]!.install.configPath);
  const agents = results.map((result) => (result.install.agent === "codex" ? "Codex" : "Claude Code"));
  const routes = results.map(
    (result) => `${result.install.agent}: ${routedDestinationNames(config, result.install.agent).join(", ")}`,
  );
  const service = results.find((result) => result.service)?.service;
  const backfill = results.find((result) => result.backfill)?.backfill;
  return [
    "trAIce collector is ready.",
    `Agents: ${agents.join(", ")}`,
    ...routes.map((route) => `Route: ${route}`),
    service
      ? `Background service: installed and started (${servicePlatformName(service.platform)})`
      : "Background service: skipped",
    backfill ? `Backfill: completed; ${backfill.accepted ?? 0} events accepted` : "Backfill: skipped",
    "",
    `Restart running ${agents.join(" and ")} sessions. Existing sessions will not pick up the new telemetry settings.`,
    "",
    "Useful commands:",
    "  npx @traice/collector@latest status",
    "  npx @traice/collector@latest destination list",
    "  npx @traice/collector@latest route list",
    "  npx @traice/collector@latest update --check",
    "  npx @traice/collector@latest backfill codex --since 7d --dry-run",
  ].join("\n");
}

function formatInstallResult(result: Awaited<ReturnType<typeof installAgent>>): string {
  const agent = result.agent === "codex" ? "Codex" : "Claude Code";
  return [
    `${agent} telemetry is configured.`,
    `Destination: ${result.destination}`,
    `Credential: ${result.credential.backend}`,
    `Settings: ${result.settings.status}`,
    "Run setup to install or refresh the background collector service.",
  ].join("\n");
}

function formatBackfillResult(
  result: Awaited<ReturnType<typeof backfillCodex>> | ReturnType<typeof dryRunCodexBackfill>,
): string {
  if (result.dryRun) {
    return [
      "Codex backfill dry run complete.",
      `Window: ${result.since} to ${result.until}`,
      `Usage events found: ${result.usageEvents}`,
      `Total tokens: ${result.tokens.total}`,
      "No data was sent.",
    ].join("\n");
  }
  return [
    "Codex backfill complete.",
    `Window: ${result.since} to ${result.until}`,
    `Candidates: ${result.uploadCandidates}`,
    `Duplicates skipped: ${result.crossModeDuplicatesSkipped}`,
    `Accepted: ${result.accepted}`,
  ].join("\n");
}

function formatBenchmarkComparison(
  report: ReturnType<typeof buildBenchmarkReport>,
  rows: ReturnType<typeof benchmarkComparison>,
) {
  const lines = [
    report.title,
    `${report.baseline.label} vs ${report.candidate.label}`,
    `Repository: ${report.repository.url} @ ${report.repository.revision}`,
    "",
    "Metric                         Baseline      Candidate      Difference      Difference %",
  ];
  for (const row of rows) {
    lines.push(
      `${row.key.padEnd(30)}${formatBenchmarkNumber(row.baseline).padStart(12)}${formatBenchmarkNumber(row.candidate).padStart(15)}${formatBenchmarkNumber(row.difference, true).padStart(16)}${(row.differencePercent == null ? "N/A" : `${row.differencePercent > 0 ? "+" : ""}${row.differencePercent.toFixed(1)}%`).padStart(18)}`,
    );
  }
  lines.push("", "Run benchmark upload to create a private review draft. Upload never publishes directly.");
  return lines.join("\n");
}

function formatBenchmarkNumber(value: number, signed = false) {
  return `${signed && value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

function servicePlatformName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd user service";
  if (platform === "win32") return "Windows Startup";
  return platform;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
