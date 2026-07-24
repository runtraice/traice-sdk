import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { CollectorDestinationSummary } from "./destinations";
import { loadCollectorConfig } from "./config";
import type { AgentName } from "./types";

export const STANDARD_TEAMS = ["Engineering", "Product", "Design", "Data", "Sales", "Marketing", "Operations"] as const;

export interface SetupIdentityInput {
  configPath?: string;
  employeeEmail?: string;
  teamName?: string;
}

interface IdentityDependencies {
  interactive?: boolean;
  gitEmail?: () => string | undefined;
  prompt?: (question: string) => Promise<string>;
}

export async function resolveFirstRunSetupIdentity(
  input: SetupIdentityInput,
  dependencies: IdentityDependencies = {},
): Promise<{ employeeEmail?: string; teamName?: string }> {
  const gitEmail = normalizeEmail((dependencies.gitEmail ?? readGitEmail)());
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return normalizedInput(input);
  const prompt = dependencies.prompt ?? promptLine;

  const providedEmail = normalizeEmail(input.employeeEmail);
  const employeeEmail = await chooseEmail(uniqueValues([providedEmail, gitEmail]), prompt);
  const teamName = await chooseTeam(normalizeTeam(input.teamName) ?? STANDARD_TEAMS[0], prompt);
  return { employeeEmail, teamName };
}

export async function confirmSetupPlan(
  input: {
    agents: AgentName[];
    destinations: string[];
    service: boolean;
    backfillDays?: number;
  },
  dependencies: Pick<IdentityDependencies, "interactive" | "prompt"> = {},
): Promise<{ service: boolean; backfill: boolean }> {
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error("Setup requires an interactive terminal. Use install for unattended API-key automation.");
  }
  const prompt = dependencies.prompt ?? promptLine;
  const agentNames = input.agents.map(displayAgent).join(", ");
  const configure = await confirm(
    `Configure ${agentNames} telemetry for ${input.destinations.join(", ")}?`,
    false,
    prompt,
  );
  if (!configure) throw new Error("Setup cancelled before changing agent telemetry.");

  const service = input.service
    ? await confirm("Install and start the collector as a background service?", true, prompt)
    : false;
  const backfill =
    input.backfillDays === undefined || !input.agents.includes("codex")
      ? false
      : await confirm(
          `Import up to ${input.backfillDays} day${input.backfillDays === 1 ? "" : "s"} of best-effort local Codex history?`,
          false,
          prompt,
        );
  return { service, backfill };
}

export function detectSupportedAgents(
  input: {
    configPath?: string;
    claudeHome?: string;
    codexHome?: string;
  } = {},
): AgentName[] {
  const configured = (() => {
    try {
      return loadCollectorConfig(input.configPath).enabledAgents;
    } catch {
      return [];
    }
  })();
  const detected = [
    ...(existsSync(resolve(input.codexHome ?? homedir(), input.codexHome ? "" : ".codex")) ? ["codex" as const] : []),
    ...(existsSync(resolve(input.claudeHome ?? homedir(), input.claudeHome ? "" : ".claude"))
      ? ["claude-code" as const]
      : []),
  ];
  return uniqueValues([...configured, ...detected]) as AgentName[];
}

export async function chooseSetupAgents(
  detected: AgentName[],
  requested?: AgentName[],
  dependencies: Pick<IdentityDependencies, "interactive" | "prompt"> = {},
): Promise<AgentName[]> {
  if (requested?.length) return uniqueValues(requested) as AgentName[];
  const candidates = detected.length > 0 ? detected : (["codex", "claude-code"] as AgentName[]);
  return chooseMany("Coding agents", candidates, candidates, (agent) => displayAgent(agent), dependencies);
}

export async function chooseSetupDestinations(
  destinations: CollectorDestinationSummary[],
  requested?: string[],
  dependencies: Pick<IdentityDependencies, "interactive" | "prompt"> = {},
): Promise<string[]> {
  const names = destinations.map((destination) => destination.name);
  if (requested?.length) {
    const selected = uniqueValues(requested);
    for (const name of selected) {
      if (!names.includes(name)) throw new Error(`Collector destination "${name}" was not found.`);
    }
    return selected;
  }
  return chooseMany(
    "Workspace destinations",
    names,
    names,
    (name) => {
      const destination = destinations.find((candidate) => candidate.name === name)!;
      return `${name} (${destination.workspaceName ?? destination.workspaceId ?? "API key workspace"})`;
    },
    dependencies,
  );
}

function normalizedInput(input: SetupIdentityInput) {
  return {
    employeeEmail: normalizeEmail(input.employeeEmail),
    teamName: normalizeTeam(input.teamName),
  };
}

async function chooseEmail(candidates: string[], prompt: (question: string) => Promise<string>): Promise<string> {
  if (candidates.length === 0) return promptForEmail(prompt);
  const options = [...candidates, "Enter another email"];
  const choice = await chooseOption("Employee email", options, 0, prompt);
  return choice === "Enter another email" ? promptForEmail(prompt) : choice;
}

async function promptForEmail(prompt: (question: string) => Promise<string>): Promise<string> {
  while (true) {
    const email = normalizeEmail(await prompt("Employee email: "));
    if (email) return email;
    process.stderr.write("Enter a valid email address.\n");
  }
}

async function chooseTeam(selected: string, prompt: (question: string) => Promise<string>): Promise<string> {
  const teams = uniqueValues([selected, ...STANDARD_TEAMS]);
  const options = [...teams, "Enter another team"];
  const choice = await chooseOption("Team", options, 0, prompt);
  if (choice !== "Enter another team") return choice;
  while (true) {
    const team = normalizeTeam(await prompt("Team name: "));
    if (team) return team;
    process.stderr.write("Enter a team name.\n");
  }
}

async function chooseOption(
  title: string,
  options: string[],
  defaultIndex: number,
  prompt: (question: string) => Promise<string>,
): Promise<string> {
  const menu = options
    .map((option, index) => `  ${index + 1}. ${option}${index === defaultIndex ? " (default)" : ""}`)
    .join("\n");
  while (true) {
    const defaultOption = options[defaultIndex]!;
    const answer = (
      await prompt(
        `${title}:\n${menu}\nPress Enter to use ${defaultIndex + 1} (${defaultOption}), or type 1-${options.length}: `,
      )
    ).trim();
    if (!answer) return options[defaultIndex]!;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index];
    process.stderr.write(`Choose a number from 1 to ${options.length}.\n`);
  }
}

function readGitEmail(): string | undefined {
  const result = spawnSync("git", ["config", "--get", "user.email"], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function promptLine(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}

async function confirm(
  question: string,
  defaultValue: boolean,
  prompt: (question: string) => Promise<string>,
): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    process.stderr.write("Enter y or n.\n");
  }
}

function normalizeEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function normalizeTeam(value: string | undefined): string | undefined {
  const team = value?.trim();
  if (!team) return undefined;
  return STANDARD_TEAMS.find((standard) => standard.toLowerCase() === team.toLowerCase()) ?? team;
}

function uniqueValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

async function chooseMany<T extends string>(
  title: string,
  options: T[],
  defaults: T[],
  label: (value: T) => string,
  dependencies: Pick<IdentityDependencies, "interactive" | "prompt">,
): Promise<T[]> {
  if (options.length === 0) throw new Error(`No ${title.toLowerCase()} are available.`);
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) throw new Error(`${title} selection requires an interactive terminal.`);
  const prompt = dependencies.prompt ?? promptLine;
  const menu = options
    .map((option, index) => `  ${index + 1}. [${defaults.includes(option) ? "x" : " "}] ${label(option)}`)
    .join("\n");
  while (true) {
    const answer = (
      await prompt(`${title}:\n${menu}\nPress Enter for the checked items, or enter numbers separated by commas: `)
    ).trim();
    if (!answer) return defaults;
    const indexes = uniqueValues(answer.split(",").map((value) => value.trim()))
      .map(Number)
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= options.length);
    if (indexes.length > 0) return indexes.map((index) => options[index - 1]!);
    process.stderr.write(`Choose one or more numbers from 1 to ${options.length}.\n`);
  }
}

function displayAgent(agent: AgentName): string {
  return agent === "codex" ? "Codex" : "Claude Code";
}
