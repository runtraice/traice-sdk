import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { resolveConfigPath } from "./config";

export const STANDARD_TEAMS = ["Engineering", "Product", "Design", "Data", "Sales", "Marketing", "Operations"] as const;

export interface SetupIdentityInput {
  configPath?: string;
  employeeEmail?: string;
  teamName?: string;
  acceptDefaults?: boolean;
}

interface IdentityDependencies {
  interactive?: boolean;
  configExists?: (path: string) => boolean;
  gitEmail?: () => string | undefined;
  prompt?: (question: string) => Promise<string>;
}

export async function resolveFirstRunSetupIdentity(
  input: SetupIdentityInput,
  dependencies: IdentityDependencies = {},
): Promise<{ employeeEmail?: string; teamName?: string }> {
  const configPath = resolveConfigPath(input.configPath);
  const configExists = dependencies.configExists ?? existsSync;
  if (configExists(configPath)) return normalizedInput(input);

  const gitEmail = normalizeEmail((dependencies.gitEmail ?? readGitEmail)());
  if (input.acceptDefaults) {
    return {
      employeeEmail: normalizeEmail(input.employeeEmail) ?? gitEmail,
      teamName: normalizeTeam(input.teamName) ?? STANDARD_TEAMS[0],
    };
  }

  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) return normalizedInput(input);
  const prompt = dependencies.prompt ?? promptLine;

  const providedEmail = normalizeEmail(input.employeeEmail);
  const employeeEmail = await chooseEmail(uniqueValues([providedEmail, gitEmail]), prompt);
  const teamName = await chooseTeam(normalizeTeam(input.teamName) ?? STANDARD_TEAMS[0], prompt);
  return { employeeEmail, teamName };
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
