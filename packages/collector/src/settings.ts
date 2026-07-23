import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveHome } from "./fs";

const CODEX_BEGIN = "# BEGIN trAIce Collector Codex OTel";
const CODEX_END = "# END trAIce Collector Codex OTel";
const CODEX_MANAGED_KEYS = new Set(["environment", "exporter", "log_user_prompt"]);

export interface SettingsPatchResult {
  status: "patched" | "skipped";
  path: string;
  snippet?: unknown;
}

export function claudeCodeEnv(options: {
  listenHost: string;
  listenPort: number;
  includePrompts: boolean;
}): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://${options.listenHost}:${options.listenPort}`,
    OTEL_LOG_USER_PROMPTS: options.includePrompts ? "1" : "0",
  };
}

export function patchClaudeSettings(options: {
  claudeHome: string;
  listenHost: string;
  listenPort: number;
  includePrompts: boolean;
  patch: boolean;
}): SettingsPatchResult {
  const settingsPath = resolve(resolveHome(options.claudeHome), "settings.json");
  const snippet = { env: claudeCodeEnv(options) };

  if (!options.patch) {
    return { status: "skipped", path: settingsPath, snippet };
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  const current = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const next = {
    ...current,
    env: {
      ...(typeof current.env === "object" && current.env ? current.env : {}),
      ...snippet.env,
    },
  };
  writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  return { status: "patched", path: settingsPath };
}

export function codexTomlBlock(options: { listenHost: string; listenPort: number; includePrompts: boolean }): string {
  return [CODEX_BEGIN, "[otel]", ...codexOtelAssignments(options), CODEX_END].join("\n");
}

function codexOtelAssignments(options: { listenHost: string; listenPort: number; includePrompts: boolean }): string[] {
  return [
    'environment = "traice-device"',
    `exporter = { otlp-http = { endpoint = "http://${options.listenHost}:${options.listenPort}/v1/logs", protocol = "json" } }`,
    `log_user_prompt = ${options.includePrompts ? "true" : "false"}`,
  ];
}

export function patchCodexConfig(options: {
  codexHome: string;
  listenHost: string;
  listenPort: number;
  includePrompts: boolean;
  patch: boolean;
}): SettingsPatchResult {
  const configPath = resolve(resolveHome(options.codexHome), "config.toml");
  const snippet = codexTomlBlock(options);

  if (!options.patch) return { status: "skipped", path: configPath, snippet };

  mkdirSync(dirname(configPath), { recursive: true });
  const current = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const next = patchCodexToml(current, options);
  atomicWrite(configPath, next);
  return { status: "patched", path: configPath };
}

export function patchCodexToml(
  current: string,
  options: { listenHost: string; listenPort: number; includePrompts: boolean },
): string {
  const withoutOldBlocks = current.replace(
    new RegExp(`${escapeRegExp(CODEX_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_END)}\\n?`, "g"),
    "",
  );
  const chunks = tomlChunks(withoutOldBlocks);
  const otelChunks = chunks.filter((chunk) => chunk.kind === "table" && isOtelTable(chunk.header));
  const firstOtel = otelChunks[0];

  if (!firstOtel) {
    const withoutExporterTables = chunks
      .filter((chunk) => chunk.kind !== "table" || !isOtelExporterTable(chunk.header))
      .map(renderTomlChunk)
      .join("");
    return `${withoutExporterTables.trimEnd()}\n\n${codexTomlBlock(options)}\n`;
  }

  for (const duplicate of otelChunks.slice(1)) {
    const unmanaged = duplicate.body.filter((line) => !safeDuplicateOtelLine(line));
    if (unmanaged.length > 0) {
      throw new Error(
        "Codex config contains duplicate [otel] tables with settings not managed by trAIce. " +
          "Setup left config.toml unchanged. Merge those tables manually and run setup again.",
      );
    }
  }

  const managedBody = [
    `${CODEX_BEGIN}\n`,
    ...codexOtelAssignments(options).map((line) => `${line}\n`),
    `${CODEX_END}\n`,
  ];
  const preservedBody = firstOtel.body.filter((line) => !managedOtelLine(line));
  const replacement = {
    ...firstOtel,
    body: [...managedBody, ...trimLeadingBlankLines(preservedBody)],
  };
  let replaced = false;
  const next = chunks
    .flatMap((chunk) => {
      if (chunk.kind === "table" && isOtelExporterTable(chunk.header)) return [];
      if (chunk.kind !== "table" || !isOtelTable(chunk.header)) return [chunk];
      if (replaced) return [];
      replaced = true;
      return [replacement];
    })
    .map(renderTomlChunk)
    .join("");

  if (countOtelTables(next) !== 1) {
    throw new Error("Collector could not produce one valid [otel] table. Setup left config.toml unchanged.");
  }
  return `${next.trimEnd()}\n`;
}

type TomlChunk = { kind: "preamble"; body: string[] } | { kind: "table"; header: string; body: string[] };

function tomlChunks(value: string): TomlChunk[] {
  const lines = value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks: TomlChunk[] = [{ kind: "preamble", body: [] }];
  for (const line of lines) {
    if (isTomlTableHeader(line)) {
      chunks.push({ kind: "table", header: line, body: [] });
      continue;
    }
    chunks[chunks.length - 1]!.body.push(line);
  }
  return chunks;
}

function renderTomlChunk(chunk: TomlChunk): string {
  return chunk.kind === "preamble" ? chunk.body.join("") : `${chunk.header}${chunk.body.join("")}`;
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[\[?[^\]\n]+\]\]?\s*(?:#.*)?(?:\n)?$/.test(line);
}

function isOtelTable(line: string): boolean {
  return /^\s*\[\s*(?:otel|"otel"|'otel')\s*\]\s*(?:#.*)?(?:\n)?$/.test(line);
}

function isOtelExporterTable(line: string): boolean {
  return /^\s*\[\s*(?:otel|"otel"|'otel')\s*\.\s*(?:exporter|"exporter"|'exporter')(?:\s*\.|\s*\])/.test(line);
}

function managedOtelLine(line: string): boolean {
  if (line.trim() === CODEX_BEGIN || line.trim() === CODEX_END) return true;
  const assignment = line.match(/^\s*(?:([A-Za-z0-9_-]+)|"([^"]+)"|'([^']+)')\s*=/);
  const key = assignment?.[1] ?? assignment?.[2] ?? assignment?.[3];
  return key ? CODEX_MANAGED_KEYS.has(key) : false;
}

function safeDuplicateOtelLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#") || managedOtelLine(line);
}

function trimLeadingBlankLines(lines: string[]): string[] {
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  return firstContent === -1 ? [] : lines.slice(firstContent);
}

function countOtelTables(value: string): number {
  return (value.match(/^\s*\[\s*(?:otel|"otel"|'otel')\s*\]\s*(?:#.*)?$/gm) ?? []).length;
}

function atomicWrite(path: string, value: string): void {
  if (process.platform === "win32") {
    writeFileSync(path, value, { mode: 0o600 });
    return;
  }
  const temporaryPath = `${path}.traice-tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, value, { mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The rename succeeded or the temporary file was never created.
    }
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
