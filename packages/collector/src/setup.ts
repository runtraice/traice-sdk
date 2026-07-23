import packageMetadata from "../package.json";
import { loginAndStoreCollectorAuthorization, resolveCollectorAccessToken, type CollectorLoginResult } from "./auth";
import { backfillCodex, type CodexBackfillSummary } from "./backfill";
import { loadCollectorConfig, resolveConfigPath } from "./config";
import { normalizeUrl, readHiddenSecret } from "./fs";
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
  report?: (message: string) => void;
  openBrowser?: (url: string) => boolean;
  login?: (
    options: Parameters<typeof loginAndStoreCollectorAuthorization>[0],
    dependencies?: Parameters<typeof loginAndStoreCollectorAuthorization>[1],
  ) => Promise<CollectorLoginResult>;
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
  const report = dependencies.report ?? console.error;
  let install = await installWithAuthorization(options, promptSecret, report, dependencies);

  try {
    await verifyCollectorConnection(install.configPath, dependencies.fetchImpl);
  } catch (error) {
    if (!(error instanceof CollectorConnectionError) || error.status !== 401 || hasProvidedKey(options)) throw error;
    const config = loadCollectorConfig(install.configPath);
    if (config.authorization?.type === "oauth") {
      report(`The saved browser authorization for ${config.authorization.workspaceName} is no longer valid.`);
    } else {
      report(
        `The saved API key was rejected by ${config.serverUrl}. It may be revoked, incomplete, or from another workspace. ` +
          "Opening browser authorization instead.",
      );
    }
    await loginForSetup(options, report, dependencies);
    install = await installAgent({ ...options, patchSettings: true });
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
  let accessToken: string;
  try {
    accessToken = await resolveCollectorAccessToken(resolved, { fetchImpl });
  } catch {
    throw new CollectorConnectionError("The stored trAIce credential is unavailable.", 401);
  }
  const url = new URL("/api/v1/collector/me", config.serverUrl);
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  if (response.status === 401) {
    throw new CollectorConnectionError(
      `The trAIce server at ${config.serverUrl} rejected the collector credential. Reauthorize or check that the API key belongs to the intended workspace.`,
      401,
    );
  }
  throw new CollectorConnectionError(
    `Collector connection check returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    response.status,
  );
}

async function installWithAuthorization(
  options: CollectorSetupOptions,
  promptSecret: (prompt?: string) => Promise<string>,
  report: (message: string) => void,
  dependencies: SetupDependencies,
): Promise<InstallResult> {
  const current = existingConfig(options.configPath);
  if (
    !hasProvidedKey(options) &&
    options.serverUrl &&
    current &&
    normalizeUrl(options.serverUrl) !== normalizeUrl(current.serverUrl)
  ) {
    report(
      `Authorizing ${normalizeUrl(options.serverUrl)} because the saved credential belongs to ${current.serverUrl}.`,
    );
    await loginForSetup(options, report, dependencies);
  }

  try {
    return await installAgent({ ...options, patchSettings: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Missing collector credential")) throw error;
    if (hasProvidedKey(options)) {
      const apiKey = await promptSecret();
      return installAgent({ ...options, apiKey, apiKeyStdin: false, patchSettings: true });
    }
    await loginForSetup(options, report, dependencies);
    return installAgent({ ...options, patchSettings: true });
  }
}

async function loginForSetup(
  options: CollectorSetupOptions,
  report: (message: string) => void,
  dependencies: SetupDependencies,
) {
  return (dependencies.login ?? loginAndStoreCollectorAuthorization)(
    {
      configPath: options.configPath,
      serverUrl: options.serverUrl,
      credentialStore: options.credentialStore,
      noBrowser: options.noBrowser,
      workspaceHint: options.workspaceHint,
    },
    {
      fetchImpl: dependencies.fetchImpl,
      openBrowser: dependencies.openBrowser,
      report,
    },
  );
}

function existingConfig(configPath?: string) {
  try {
    return loadCollectorConfig(configPath);
  } catch {
    return null;
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
