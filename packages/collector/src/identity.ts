import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const STANDARD_TEAMS = ["Engineering", "Product", "Design", "Data", "Sales", "Marketing", "Operations"] as const;

export interface SetupIdentityInput {
  configPath?: string;
  employeeEmail?: string;
  teamName?: string;
  acceptDefaults?: boolean;
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

export async function confirmSetupPlan(
  input: {
    agent: "claude-code" | "codex";
    service: boolean;
    backfillDays?: number;
    acceptDefaults?: boolean;
  },
  dependencies: Pick<IdentityDependencies, "interactive" | "prompt"> = {},
): Promise<{ service: boolean; backfill: boolean }> {
  if (input.acceptDefaults) {
    return { service: input.service, backfill: input.backfillDays !== undefined };
  }
  const interactive = dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    throw new Error(
      "Interactive approval requires a terminal. Review the options, then rerun with --yes for automation.",
    );
  }
  const prompt = dependencies.prompt ?? promptLine;
  const agentName = input.agent === "codex" ? "Codex" : "Claude Code";
  const configure = await confirm(
    `Configure ${agentName} telemetry and verify the selected trAIce workspace?`,
    false,
    prompt,
  );
  if (!configure) throw new Error("Setup cancelled before changing agent telemetry.");

  const service = input.service
    ? await confirm("Install and start the collector as a background service?", true, prompt)
    : false;
  const backfill =
    input.backfillDays === undefined
      ? false
      : await confirm(
          `Import up to ${input.backfillDays} day${input.backfillDays === 1 ? "" : "s"} of best-effort local Codex history?`,
          false,
          prompt,
        );
  return { service, backfill };
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
