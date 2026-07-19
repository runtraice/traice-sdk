import packageMetadata from "../package.json";
import { backfillCodex, type CodexBackfillSummary } from "./backfill";
import { loadCollectorConfig, resolveConfigPath } from "./config";
import { readCollectorCredential } from "./credentials";
import { readHiddenSecret } from "./fs";
import { installAgent, type InstallResult } from "./install";
import { installCollectorService, type CollectorServiceResult } from "./service";
import type { CollectorInstallOptions } from "./types";

export interface CollectorSetupOptions extends CollectorInstallOptions {
  backfill?: boolean;
  backfillDays?: number;
  service?: boolean;
}

export interface CollectorSetupResult {
  ok: true;
  install: InstallResult;
  connection: { ok: true; serverUrl: string };
  service?: CollectorServiceResult;
  backfill?: CodexBackfillSummary;
}

interface SetupDependencies {
  fetchImpl?: typeof fetch;
  promptSecret?: (prompt?: string) => Promise<string>;
  installService?: typeof installCollectorService;
  runBackfill?: typeof backfillCodex;
}

class CollectorConnectionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function setupAgent(
  options: CollectorSetupOptions,
  dependencies: SetupDependencies = {},
): Promise<CollectorSetupResult> {
  const promptSecret = dependencies.promptSecret ?? readHiddenSecret;
  let install = await installWithPrompt(options, promptSecret);

  try {
    await verifyCollectorConnection(install.configPath, dependencies.fetchImpl);
  } catch (error) {
    if (!(error instanceof CollectorConnectionError) || error.status !== 401 || hasProvidedKey(options)) throw error;
    const apiKey = await promptSecret("Stored trAIce API key was rejected. Enter a new API key: ");
    install = await installAgent({ ...options, apiKey, apiKeyStdin: false, patchSettings: true });
    await verifyCollectorConnection(install.configPath, dependencies.fetchImpl);
  }

  const service =
    options.service === false
      ? undefined
      : (dependencies.installService ?? installCollectorService)({
          agent: options.agent,
          configPath: install.configPath,
          packageVersion: packageMetadata.version,
        });
  const backfillDays = boundedBackfillDays(options.backfillDays);
  const backfill =
    options.agent === "codex" && options.backfill !== false
      ? await (dependencies.runBackfill ?? backfillCodex)({
          configPath: install.configPath,
          codexHome: options.codexHome,
          since: `${backfillDays}d`,
          onProgress: ({ processed, total, accepted }) => {
            console.error(`[traice-collector] backfill ${processed}/${total}; accepted ${accepted}`);
          },
        })
      : undefined;
  const config = loadCollectorConfig(install.configPath);

  return {
    ok: true,
    install,
    connection: { ok: true, serverUrl: config.serverUrl },
    ...(service ? { service } : {}),
    ...(backfill ? { backfill } : {}),
  };
}

export async function verifyCollectorConnection(configPath?: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const resolved = resolveConfigPath(configPath);
  const config = loadCollectorConfig(resolved);
  let apiKey: string | undefined;
  try {
    apiKey = config.credential ? await readCollectorCredential(config.credential) : config.apiKey;
  } catch {
    throw new CollectorConnectionError("The stored trAIce API key is unavailable.", 401);
  }
  if (!apiKey) throw new Error("Missing collector API key. Run setup again.");
  const url = new URL("/api/v1/internal-usage", config.serverUrl);
  url.searchParams.set("limit", "1");
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}` } });
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  if (response.status === 401) {
    throw new CollectorConnectionError("The trAIce server rejected the stored API key.", 401);
  }
  throw new CollectorConnectionError(
    `Collector connection check returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    response.status,
  );
}

async function installWithPrompt(
  options: CollectorSetupOptions,
  promptSecret: (prompt?: string) => Promise<string>,
): Promise<InstallResult> {
  try {
    return await installAgent({ ...options, patchSettings: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Missing API key")) throw error;
    const apiKey = await promptSecret();
    return installAgent({ ...options, apiKey, apiKeyStdin: false, patchSettings: true });
  }
}

function hasProvidedKey(options: CollectorSetupOptions): boolean {
  return Boolean(options.apiKey || options.apiKeyStdin || process.env.TRAICE_API_KEY);
}

function boundedBackfillDays(value = 7): number {
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error(`Invalid backfill days: ${value}. Expected an integer from 1 to 30.`);
  }
  return value;
}
