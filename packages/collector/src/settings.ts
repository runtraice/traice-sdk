import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveHome } from "./fs";

const CODEX_BEGIN = "# BEGIN trAIce Collector Codex OTel";
const CODEX_END = "# END trAIce Collector Codex OTel";

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
  return [
    CODEX_BEGIN,
    "[otel]",
    'environment = "traice-device"',
    `exporter = { otlp = { endpoint = "http://${options.listenHost}:${options.listenPort}/v1/logs", protocol = "http/json" } }`,
    `log_user_prompt = ${options.includePrompts ? "true" : "false"}`,
    CODEX_END,
  ].join("\n");
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
  const withoutOldBlock = current.replace(
    new RegExp(`${escapeRegExp(CODEX_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_END)}\\n?`, "g"),
    "",
  );
  const next = `${withoutOldBlock.trimEnd()}\n\n${snippet}\n`;
  writeFileSync(configPath, next);
  return { status: "patched", path: configPath };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
