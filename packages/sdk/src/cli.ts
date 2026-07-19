#!/usr/bin/env node

import { Command } from "commander";
import packageMetadata from "../package.json";
import * as fs from "fs";
import * as readline from "readline";
import chalk from "chalk";
import Table from "cli-table3";
import { CostEvent, ReportOptions } from "./types";
import { filterEvents, summarize, generateInsight } from "./reporters/summary";
import { summaryToCsv } from "./reporters/csv";
import { summaryToJson } from "./reporters/json";
import { forecast } from "./analytics/forecast";
import { detectAnomalies } from "./analytics/anomalies";
import { comparePromptVersions } from "./analytics/compare";
import { optimizeModels } from "./analytics/optimizer";
import { detectTokenAbuse } from "./analytics/token-abuse";
import { askTraice, confirmAskAction, prepareAskAction, type AskActionInput } from "./ask";
import { deleteCliCredential, resolveCliCredential, storeCliCredential } from "./cli-credentials";

const DEFAULT_FILE = "./.traice-costs/events.ndjson";

async function loadEvents(filePath: string): Promise<CostEvent[]> {
  if (!fs.existsSync(filePath)) {
    console.error(chalk.red(`File not found: ${filePath}`));
    console.error(chalk.gray("Run your app with @traice/sdk to generate events, or use --file to specify a path."));
    process.exit(1);
  }

  const events: CostEvent[] = [];
  let malformed = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }

  if (malformed > 0) {
    console.error(
      chalk.yellow(`Warning: Skipped ${malformed} malformed line${malformed > 1 ? "s" : ""} in ${filePath}`),
    );
  }

  if (events.length === 0) {
    console.error(chalk.yellow(`No valid events found in ${filePath}`));
    process.exit(1);
  }

  return events;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
  if (n < 0.01) {
    return `$${n.toFixed(5)}`;
  }
  return `$${n.toFixed(2)}`;
}

function printTable(options: ReportOptions, events: CostEvent[]): void {
  const groupBy = options.groupBy ?? "feature";
  const filtered = filterEvents(events, options);

  if (filtered.length === 0) {
    console.log(chalk.yellow("No events found matching the given filters."));
    return;
  }

  let rows = summarize(filtered, groupBy);

  if (options.top) {
    rows = rows.slice(0, options.top);
  }

  const timestamps = filtered.map((e) => e.timestamp).sort();
  const fromDate = timestamps[0]?.substring(0, 10) ?? "";
  const toDate = timestamps[timestamps.length - 1]?.substring(0, 10) ?? "";

  console.log("");
  console.log(chalk.bold(`@traice/sdk report: ${fromDate} to ${toDate}`));
  console.log(chalk.gray(`Source: ${options.file ?? DEFAULT_FILE} (${formatNumber(filtered.length)} events)`));
  console.log("");
  console.log(chalk.bold(`By ${groupBy}:`));

  const table = new Table({
    head: [
      chalk.white(groupBy.charAt(0).toUpperCase() + groupBy.slice(1)),
      chalk.white("Calls"),
      chalk.white("Total Tokens"),
      chalk.white("Avg Cost/Call"),
      chalk.white("Total Cost"),
    ],
    style: { head: [], border: [] },
  });

  let totalCalls = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const row of rows) {
    totalCalls += row.calls;
    totalTokens += row.totalTokens;
    totalCost += row.totalCost;

    table.push([
      row.key,
      formatNumber(row.calls),
      formatNumber(row.totalTokens),
      formatCost(row.avgCostPerCall),
      formatCost(row.totalCost),
    ]);
  }

  table.push([
    chalk.bold("TOTAL"),
    chalk.bold(formatNumber(totalCalls)),
    chalk.bold(formatNumber(totalTokens)),
    chalk.gray("-"),
    chalk.bold(formatCost(totalCost)),
  ]);

  console.log(table.toString());

  const insight = generateInsight(rows);
  if (insight) {
    console.log("");
    console.log(chalk.cyan(`Insight: ${insight}`));
  }
  console.log("");
}

const program = new Command();

program
  .name("traice")
  .description("Per-feature, per-user cost attribution and reporting for LLM API calls")
  .version(packageMetadata.version);

const authCommand = program.command("auth").description("Manage the saved trAIce API credential");

authCommand
  .command("login")
  .description("Save TRAICE_API_KEY in the operating system credential store")
  .option("--server-url <url>", "trAIce server URL")
  .action(async (opts) => {
    const apiKey = process.env.TRAICE_API_KEY?.trim();
    if (!apiKey) {
      console.error(chalk.red("TRAICE_API_KEY is not set."));
      console.error(chalk.gray("Export it for this command, then unset it after the credential is saved."));
      process.exitCode = 1;
      return;
    }
    try {
      const stored = await storeCliCredential(apiKey, opts.serverUrl ?? process.env.TRAICE_SERVER_URL);
      console.log(
        chalk.green(
          `Saved trAIce credential in ${stored.backend === "os-keyring" ? "the OS keyring" : "a protected file"}.`,
        ),
      );
      if (stored.warning) console.error(chalk.yellow(stored.warning));
      console.log(chalk.gray("You can now unset TRAICE_API_KEY and use `traice ask`."));
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

authCommand
  .command("logout")
  .description("Delete the saved trAIce API credential")
  .action(async () => {
    try {
      const removed = await deleteCliCredential();
      console.log(removed ? "Deleted the saved trAIce credential." : "No saved trAIce credential was found.");
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

program
  .command("ask")
  .description("Ask a natural-language question about workspace spend, margin, waste, budgets, or alerts")
  .argument("<question>", "Question to ask")
  .option("--server-url <url>", "trAIce server URL")
  .option("--json", "Print the structured response as JSON")
  .action(async (question: string, opts) => {
    try {
      const credential = await resolveCliCredential(opts.serverUrl);
      const result = await askTraice(question, credential);
      console.log(opts.json ? JSON.stringify(result, null, 2) : result.answer);
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

const actionCommand = program
  .command("action")
  .description("Prepare and explicitly confirm Team-plan Ask trAIce actions");

actionCommand
  .command("prepare-budget")
  .description("Prepare a budget without creating it")
  .requiredOption("--name <name>", "Budget name")
  .requiredOption("--limit-usd <amount>", "Budget limit in USD", Number)
  .option("--scope <scope>", "WORKSPACE, FEATURE, USER, or TENANT", "WORKSPACE")
  .option("--scope-value <value>", "Feature, user, or tenant identifier")
  .option("--period <period>", "DAILY, WEEKLY, or MONTHLY", "MONTHLY")
  .option("--server-url <url>", "trAIce server URL")
  .option("--json", "Print the structured response as JSON")
  .action(async (opts) => {
    await runPrepareAction(
      {
        action: "create_budget",
        name: opts.name,
        limitUsd: opts.limitUsd,
        scope: String(opts.scope).toUpperCase() as Extract<AskActionInput, { action: "create_budget" }>["scope"],
        scopeValue: opts.scopeValue,
        period: String(opts.period).toUpperCase() as Extract<AskActionInput, { action: "create_budget" }>["period"],
      },
      opts,
    );
  });

actionCommand
  .command("prepare-alert-snooze")
  .description("Prepare a reversible alert snooze")
  .argument("<alert-id>", "Active alert ID")
  .option("--hours <hours>", "Snooze duration from 1 to 720 hours", Number, 24)
  .option("--reason <reason>", "Audit reason")
  .option("--server-url <url>", "trAIce server URL")
  .option("--json", "Print the structured response as JSON")
  .action(async (alertId: string, opts) => {
    await runPrepareAction({ action: "snooze_alert", alertId, hours: opts.hours, reason: opts.reason }, opts);
  });

actionCommand
  .command("prepare-shadow-guardrail")
  .description("Prepare an evidence-gated shadow guardrail from an experiment")
  .argument("<experiment-id>", "Eligible experiment ID")
  .option("--server-url <url>", "trAIce server URL")
  .option("--json", "Print the structured response as JSON")
  .action(async (experimentId: string, opts) => {
    await runPrepareAction({ action: "create_shadow_guardrail", experimentId }, opts);
  });

actionCommand
  .command("confirm")
  .description("Execute a prepared action after reviewing its summary")
  .requiredOption("--token <token>", "Short-lived confirmation token")
  .requiredOption("--phrase <phrase>", "Exact confirmation phrase, including CONFIRM")
  .option("--server-url <url>", "trAIce server URL")
  .option("--json", "Print the structured response as JSON")
  .action(async (opts) => {
    try {
      const credential = await resolveCliCredential(opts.serverUrl);
      const result = await confirmAskAction(opts.token, opts.phrase, credential);
      console.log(opts.json ? JSON.stringify(result, null, 2) : chalk.green(JSON.stringify(result.result, null, 2)));
    } catch (error) {
      console.error(chalk.red(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    }
  });

async function runPrepareAction(action: AskActionInput, opts: { serverUrl?: string; json?: boolean }) {
  try {
    const credential = await resolveCliCredential(opts.serverUrl);
    const result = await prepareAskAction(action, credential);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.summary);
    console.log(
      chalk.yellow(`No change has been made. Review the summary, then confirm with ${result.confirmationPhrase}.`),
    );
    console.log(
      chalk.gray(
        `traice action confirm --token '${result.confirmationToken}' --phrase '${result.confirmationPhrase}'${opts.serverUrl ? ` --server-url '${opts.serverUrl}'` : ""}`,
      ),
    );
    console.log(chalk.gray(`Expires ${result.expiresAt}.`));
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

program
  .command("report")
  .description("Generate a cost report from tracked LLM events")
  .option(
    "--group-by <dimension>",
    "Group results by dimension (feature, userId, model, env, provider, sessionId)",
    "feature",
  )
  .option("--feature <name>", "Filter by feature name")
  .option("--env <environment>", "Filter by environment")
  .option("--user <userId>", "Filter by user ID")
  .option("--from <date>", "Filter events from date (YYYY-MM-DD)")
  .option("--to <date>", "Filter events to date (YYYY-MM-DD)")
  .option("--top <n>", "Show top N results", parseInt)
  .option("--format <type>", "Output format: table, csv, json", "table")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .action(async (opts) => {
    const reportOptions: ReportOptions = {
      groupBy: opts.groupBy,
      feature: opts.feature,
      env: opts.env,
      userId: opts.user,
      from: opts.from,
      to: opts.to,
      top: opts.top,
      format: opts.format as "table" | "csv" | "json",
      file: opts.file,
    };

    const events = await loadEvents(opts.file);

    switch (reportOptions.format) {
      case "csv": {
        const filtered = filterEvents(events, reportOptions);
        let rows = summarize(filtered, reportOptions.groupBy ?? "feature");
        if (reportOptions.top) rows = rows.slice(0, reportOptions.top);
        console.log(summaryToCsv(rows, reportOptions.groupBy ?? "feature"));
        break;
      }
      case "json": {
        const filtered = filterEvents(events, reportOptions);
        let rows = summarize(filtered, reportOptions.groupBy ?? "feature");
        if (reportOptions.top) rows = rows.slice(0, reportOptions.top);
        console.log(summaryToJson(rows, reportOptions.groupBy ?? "feature"));
        break;
      }
      default:
        printTable(reportOptions, events);
        break;
    }
  });

program
  .command("forecast")
  .description("Forecast monthly LLM spend based on historical data")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (opts) => {
    const events = await loadEvents(opts.file);
    const results = forecast(events);

    if (results.length === 0) {
      console.log(chalk.yellow("Not enough data to forecast."));
      return;
    }

    if (opts.format === "json") {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log("");
    console.log(chalk.bold("@traice/sdk forecast"));
    console.log("");

    const table = new Table({
      head: [
        chalk.white("Feature"),
        chalk.white("Current Spend"),
        chalk.white("Daily Avg"),
        chalk.white("Projected /mo"),
        chalk.white("Trend"),
      ],
      style: { head: [], border: [] },
    });

    for (const r of results) {
      const trendIcon =
        r.trend === "up"
          ? chalk.red("^ " + r.trendPercent + "%")
          : r.trend === "down"
            ? chalk.green("v " + r.trendPercent + "%")
            : chalk.gray("- flat");

      table.push([
        r.feature,
        formatCost(r.currentSpend),
        formatCost(r.dailyAverage),
        chalk.bold(formatCost(r.projectedMonthly)),
        trendIcon,
      ]);
    }

    console.log(table.toString());
    console.log("");
  });

program
  .command("anomalies")
  .description("Detect cost anomalies compared to rolling average")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .option("--window <days>", "Rolling average window in days", parseInt)
  .option("--threshold <ratio>", "Anomaly threshold (e.g. 2.0 = 2x average)", parseFloat)
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (opts) => {
    const events = await loadEvents(opts.file);
    const results = detectAnomalies(events, {
      windowDays: opts.window,
      threshold: opts.threshold,
    });

    if (results.length === 0) {
      console.log(chalk.green("No anomalies detected."));
      return;
    }

    if (opts.format === "json") {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log("");
    console.log(chalk.bold(`@traice/sdk anomalies (${results.length} found)`));
    console.log("");

    const table = new Table({
      head: [
        chalk.white("Date"),
        chalk.white("Feature"),
        chalk.white("Cost"),
        chalk.white("Avg"),
        chalk.white("Ratio"),
        chalk.white("Severity"),
      ],
      style: { head: [], border: [] },
    });

    for (const a of results) {
      const severityColor = a.severity === "high" ? chalk.red : chalk.yellow;
      table.push([
        a.date,
        a.feature,
        formatCost(a.cost),
        formatCost(a.average),
        severityColor(a.ratio + "x"),
        severityColor(a.severity),
      ]);
    }

    console.log(table.toString());
    console.log("");
  });

program
  .command("token-abuse")
  .description("Detect runaway token usage by a single user")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .option("--from <date>", "Filter events from date (YYYY-MM-DD)")
  .option("--to <date>", "Filter events to date (YYYY-MM-DD)")
  .option("--min-users <n>", "Minimum distinct users required", parseInt)
  .option("--min-tokens <n>", "Minimum user token volume", parseInt)
  .option("--min-cost <usd>", "Minimum user spend in USD", parseFloat)
  .option("--min-share <pct>", "Minimum workspace token share percentage", parseFloat)
  .option("--min-multiple <x>", "Minimum multiple versus median user tokens", parseFloat)
  .option("--top <n>", "Show top N users", parseInt)
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (opts) => {
    const events = filterEvents(await loadEvents(opts.file), {
      from: opts.from,
      to: opts.to,
    });
    const results = detectTokenAbuse(events, {
      minUsers: opts.minUsers,
      minTokens: opts.minTokens,
      minCostUSD: opts.minCost,
      minWorkspaceSharePct: opts.minShare,
      minPeerMultiple: opts.minMultiple,
      maxResults: opts.top,
    });

    if (results.length === 0) {
      console.log(chalk.green("No token abuse detected."));
      return;
    }

    if (opts.format === "json") {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log("");
    console.log(chalk.bold(`@traice/sdk token-abuse (${results.length} found)`));
    console.log(chalk.gray(`Source: ${opts.file ?? DEFAULT_FILE} (${formatNumber(events.length)} events scanned)`));
    console.log("");

    const table = new Table({
      head: [
        chalk.white("User"),
        chalk.white("Events"),
        chalk.white("Tokens"),
        chalk.white("Spend"),
        chalk.white("Share"),
        chalk.white("vs Median"),
        chalk.white("Top Feature"),
        chalk.white("Severity"),
      ],
      style: { head: [], border: [] },
    });

    for (const result of results) {
      const severityColor = result.severity === "high" ? chalk.red : chalk.yellow;
      table.push([
        result.userId,
        formatNumber(result.events),
        formatNumber(result.tokens),
        formatCost(result.totalCostUSD),
        `${result.workspaceTokenSharePct.toFixed(1)}%`,
        `${result.peerMultiple.toFixed(1)}x`,
        result.topFeature,
        severityColor(result.severity),
      ]);
    }

    console.log(table.toString());
    console.log("");
    console.log(
      chalk.gray("Action: set a USER budget, throttle the path, or require an upgrade before the next expensive call."),
    );
    console.log("");
  });

program
  .command("compare")
  .description("Compare cost across prompt versions")
  .option("--prompt <name>", "Filter by prompt name")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (opts: any) => {
    const events = await loadEvents(opts.file);
    const results = comparePromptVersions(events, opts.prompt);

    if (results.length === 0) {
      console.log(chalk.yellow("No events with promptName/promptVersion found."));
      return;
    }

    if (opts.format === "json") {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log("");
    console.log(chalk.bold("@traice/sdk prompt comparison"));
    console.log("");

    const table = new Table({
      head: [
        chalk.white("Prompt"),
        chalk.white("Version"),
        chalk.white("Calls"),
        chalk.white("Avg Tokens"),
        chalk.white("Avg Cost"),
        chalk.white("Total Cost"),
        chalk.white("vs Baseline"),
      ],
      style: { head: [], border: [] },
    });

    for (const r of results) {
      const change =
        r.changeFromBaseline !== undefined && r.changeFromBaseline !== 0
          ? r.changeFromBaseline > 0
            ? chalk.red(`+${r.changeFromBaseline}%`)
            : chalk.green(`${r.changeFromBaseline}%`)
          : chalk.gray("baseline");
      table.push([
        r.promptName,
        r.version,
        String(r.calls),
        formatNumber(r.avgInputTokens + r.avgOutputTokens),
        formatCost(r.avgCostPerCall),
        formatCost(r.totalCost),
        change,
      ]);
    }

    console.log(table.toString());
    console.log("");
  });

program
  .command("optimize")
  .description("Recommend cheaper models for your features")
  .option("--file <path>", "Path to events NDJSON file", DEFAULT_FILE)
  .option("--format <type>", "Output format: table, json", "table")
  .action(async (opts: any) => {
    const events = await loadEvents(opts.file);
    const results = optimizeModels(events);

    if (results.length === 0) {
      console.log(
        chalk.green(
          "No cheaper model alternatives found. Current models are already the lowest-cost options in the pricing table.",
        ),
      );
      return;
    }

    if (opts.format === "json") {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    console.log("");
    console.log(chalk.bold("@traice/sdk model recommendations"));
    console.log("");

    const table = new Table({
      head: [
        chalk.white("Feature"),
        chalk.white("Current Model"),
        chalk.white("Current $/mo"),
        chalk.white("Recommended"),
        chalk.white("Projected $/mo"),
        chalk.white("Savings"),
      ],
      style: { head: [], border: [] },
    });

    for (const r of results) {
      table.push([
        r.feature,
        r.currentModel,
        formatCost(r.currentMonthlyCost),
        chalk.green(r.recommendedModel),
        chalk.green(formatCost(r.projectedMonthlyCost)),
        chalk.bold.green(`-${r.savingsPercent}% ($${r.savingsUSD.toFixed(2)}/mo)`),
      ]);
    }

    console.log(table.toString());
    console.log("");
    console.log(
      chalk.gray("Note: Test quality before switching models. Lower cost does not always mean equivalent results."),
    );
    console.log("");
  });

program.parse();
