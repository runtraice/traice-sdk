import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import packageMetadata from "../package.json";
import {
  DEFAULT_SERVER_URL,
  buildDefaultConfig,
  loadCollectorConfig,
  resolveConfigPath,
  writeCollectorConfig,
} from "./config";
import {
  deleteCollectorCredential,
  readCollectorCredential,
  storeCollectorCredential,
  writeCollectorCredential,
} from "./credentials";
import { normalizeUrl } from "./fs";
import {
  collectorDestination,
  configForDestination,
  defaultDestinationName,
  destinationNameFromWorkspace,
  normalizeDestinationName,
  removeCollectorDestination,
  upsertCollectorDestination,
} from "./destinations";
import type {
  CollectorConfig,
  CollectorCredential,
  CollectorDestination,
  CollectorOAuthAuthorization,
  CredentialStoreMode,
} from "./types";

const CLIENT_ID = "traice-collector";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPES = ["collector:status", "internal_usage:dedupe", "internal_usage:write"];
const EXPIRY_SKEW_MS = 60_000;
const REFRESH_LOCK_TIMEOUT_MS = 10_000;
const STALE_REFRESH_LOCK_MS = 2 * 60_000;

export interface CollectorOAuthTokenBundle {
  version: 1;
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope: string;
}

export interface CollectorLoginResult {
  destinations: Array<{
    name: string;
    credential: CollectorCredential;
    credentialWarning?: string;
    authorization: CollectorOAuthAuthorization;
  }>;
  verificationUri: string;
}

interface AuthDependencies {
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => boolean;
  report?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export async function loginAndStoreCollectorAuthorization(
  options: {
    configPath?: string;
    serverUrl?: string;
    credentialStore?: CredentialStoreMode;
    noBrowser?: boolean;
    workspaceHint?: string;
    destination?: string;
  },
  dependencies: AuthDependencies = {},
): Promise<CollectorLoginResult> {
  const configPath = resolveConfigPath(options.configPath);
  const current = existsSync(configPath) ? loadCollectorConfig(configPath) : buildDefaultConfig();
  const requestedName = options.destination ? normalizeDestinationName(options.destination) : undefined;
  const previous = requestedName ? current.destinations[requestedName] : undefined;
  const serverUrl = normalizeUrl(options.serverUrl ?? previous?.serverUrl ?? DEFAULT_SERVER_URL);
  const report = dependencies.report ?? ((message: string) => console.error(message));
  report(
    requestedName
      ? `Authorizing destination "${requestedName}" on ${new URL(serverUrl).host}.`
      : `Authorizing workspace destinations on ${new URL(serverUrl).host}.`,
  );
  const login = await loginCollectorOAuth(
    {
      serverUrl,
      noBrowser: options.noBrowser,
      workspaceHint: options.workspaceHint,
      allowMultipleWorkspaces: !requestedName,
    },
    dependencies,
  );
  if (requestedName && login.authorizations.length !== 1) {
    throw new Error("A named destination can authorize exactly one workspace. Run login without --destination.");
  }

  let next = current;
  const results: CollectorLoginResult["destinations"] = [];
  for (const [index, authorized] of login.authorizations.entries()) {
    const name =
      requestedName ??
      destinationNameFromWorkspace(
        { ...authorized.workspace, slug: authorized.workspace.slug ?? undefined },
        next.destinations,
        serverUrl,
      );
    const previousDestination = next.destinations[name];
    const stored = await storeCollectorCredential(
      configPath,
      serializeOAuthCredential(authorized.bundle),
      options.credentialStore,
      {},
      name,
    );
    const authorization: CollectorOAuthAuthorization = {
      type: "oauth",
      clientId: CLIENT_ID,
      workspaceId: authorized.workspace.id,
      workspaceName: authorized.workspace.name,
      ...(authorized.workspace.slug ? { workspaceSlug: authorized.workspace.slug } : {}),
      ...(authorized.user.email ? { userEmail: authorized.user.email } : {}),
      scopes: authorized.scope.split(/\s+/).filter(Boolean),
      authorizedAt: new Date((dependencies.now ?? Date.now)() + index).toISOString(),
    };
    next = upsertCollectorDestination(next, name, { serverUrl, credential: stored.credential, authorization });
    let credentialWarning = stored.warning;
    if (previousDestination?.credential && !sameCredential(previousDestination.credential, stored.credential)) {
      try {
        await deleteCollectorCredential(previousDestination.credential);
      } catch (error) {
        const cleanupWarning = `Could not remove the previous collector credential (${errorMessage(error)}).`;
        credentialWarning = credentialWarning ? `${credentialWarning} ${cleanupWarning}` : cleanupWarning;
      }
    }
    results.push({
      name,
      credential: stored.credential,
      ...(credentialWarning ? { credentialWarning } : {}),
      authorization,
    });
  }
  next.updatedAt = new Date((dependencies.now ?? Date.now)()).toISOString();
  writeCollectorConfig(next, configPath);
  return { destinations: results, verificationUri: login.verificationUri };
}

export async function loginCollectorOAuth(
  options: {
    serverUrl: string;
    noBrowser?: boolean;
    workspaceHint?: string;
    allowMultipleWorkspaces?: boolean;
  },
  dependencies: AuthDependencies = {},
) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const report = dependencies.report ?? ((message: string) => console.error(message));
  const sleep =
    dependencies.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const deviceResponse = await fetchImpl(`${normalizeUrl(options.serverUrl)}/api/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPES.join(" "),
      device_name: hostname(),
      client_version: packageMetadata.version,
      platform: `${platform()} ${release()}`,
      ...(options.workspaceHint ? { workspace_hint: options.workspaceHint } : {}),
      ...(options.allowMultipleWorkspaces ? { allow_multiple_workspaces: "true" } : {}),
    }),
  });
  const device = (await deviceResponse.json().catch(() => ({}))) as Record<string, unknown>;
  if (!deviceResponse.ok)
    throw oauthResponseError("Could not start browser authorization", deviceResponse.status, device);

  const deviceCode = requiredString(device.device_code, "device_code");
  const userCode = requiredString(device.user_code, "user_code");
  const verificationUri = requiredHttpsUrl(device.verification_uri, "verification_uri");
  const verificationUriComplete = optionalHttpsUrl(device.verification_uri_complete) ?? verificationUri;
  const expiresIn = positiveInteger(device.expires_in, "expires_in");
  let intervalSeconds = positiveInteger(device.interval ?? 5, "interval");
  const deadline = now() + expiresIn * 1000;

  report(`Open ${verificationUriComplete}`);
  report(`Enter code: ${userCode}`);
  if (!options.noBrowser) {
    const opened = (dependencies.openBrowser ?? openSystemBrowser)(verificationUriComplete);
    if (opened) report("The collector attempted to open your browser. Complete authorization there.");
    else report("The browser could not be opened automatically. Open the link on any device.");
  }
  report("Waiting for authorization...");

  while (now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const tokenResponse = await fetchImpl(`${normalizeUrl(options.serverUrl)}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: deviceCode,
      }),
    });
    const body = (await tokenResponse.json().catch(() => ({}))) as Record<string, unknown>;
    if (tokenResponse.ok) {
      return tokenLoginResult(body, verificationUriComplete, now());
    }
    const code = typeof body.error === "string" ? body.error : "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    if (code === "temporarily_unavailable") {
      intervalSeconds = Math.min(60, intervalSeconds + 5);
      continue;
    }
    if (code === "access_denied") throw new Error("Collector authorization was denied.");
    if (code === "expired_token") throw new Error("Collector authorization expired. Run login again.");
    throw oauthResponseError("Collector authorization failed", tokenResponse.status, body);
  }
  throw new Error("Collector authorization expired. Run login again.");
}

export async function resolveCollectorAccessToken(
  configPath?: string,
  options: { forceRefresh?: boolean; fetchImpl?: typeof fetch; now?: () => number; destination?: string } = {},
): Promise<string> {
  const resolved = resolveConfigPath(configPath);
  const rootConfig = loadCollectorConfig(resolved);
  const destinationName = normalizeDestinationName(options.destination ?? defaultDestinationName(rootConfig));
  const destination = collectorDestination(rootConfig, destinationName);
  if (destination.apiKey) {
    const legacyApiKey = destination.apiKey;
    const stored = await storeCollectorCredential(resolved, legacyApiKey, "auto", {}, destinationName);
    rootConfig.destinations[destinationName] = { ...destination, credential: stored.credential, apiKey: undefined };
    writeCollectorConfig(rootConfig, resolved);
    if (stored.warning) console.warn(`[traice-collector] ${stored.warning}`);
    return legacyApiKey;
  }
  const config = configForDestination(rootConfig, destinationName);
  if (!config.credential) throw new Error("No collector credential is stored. Run setup or auth login.");
  const stored = await readCollectorCredential(config.credential);
  if (config.authorization?.type !== "oauth") return stored;

  const now = options.now ?? Date.now;
  const current = parseOAuthCredential(stored);
  if (!options.forceRefresh && tokenIsFresh(current, now())) return current.accessToken;

  return withRefreshLock(resolved, destinationName, async () => {
    const latestRootConfig = loadCollectorConfig(resolved);
    const latestConfig = configForDestination(latestRootConfig, destinationName);
    if (!latestConfig.credential || latestConfig.authorization?.type !== "oauth") {
      throw new Error("The collector OAuth credential is no longer configured.");
    }
    const latest = parseOAuthCredential(await readCollectorCredential(latestConfig.credential));
    if (!options.forceRefresh && tokenIsFresh(latest, now())) return latest.accessToken;
    const refreshed = await refreshOAuthCredential(latestConfig, latest, options.fetchImpl ?? fetch, now());
    await writeCollectorCredential(latestConfig.credential, serializeOAuthCredential(refreshed));
    return refreshed.accessToken;
  });
}

export function createCollectorAccessTokenProvider(
  configPath?: string,
  dependencies: { fetchImpl?: typeof fetch; now?: () => number } = {},
  destination?: string,
) {
  return (forceRefresh = false) =>
    resolveCollectorAccessToken(configPath, {
      forceRefresh,
      fetchImpl: dependencies.fetchImpl,
      now: dependencies.now,
      destination,
    });
}

export async function logoutCollector(
  configPath?: string,
  fetchImpl: typeof fetch = fetch,
  requestedDestination?: string,
): Promise<{ removed: boolean; remoteRevoked: boolean }> {
  const resolved = resolveConfigPath(configPath);
  if (!existsSync(resolved)) return { removed: false, remoteRevoked: false };
  const rootConfig = loadCollectorConfig(resolved);
  const destinationName = normalizeDestinationName(requestedDestination ?? defaultDestinationName(rootConfig));
  let config: CollectorConfig & CollectorDestination;
  try {
    config = configForDestination(rootConfig, destinationName);
  } catch {
    return { removed: false, remoteRevoked: false };
  }
  if (config.authorization?.type !== "oauth" || !config.credential) {
    return { removed: false, remoteRevoked: false };
  }
  let remoteRevoked = false;
  try {
    const accessToken = await resolveCollectorAccessToken(resolved, { fetchImpl, destination: destinationName });
    const response = await fetchImpl(`${config.serverUrl}/api/v1/collector/me`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    remoteRevoked = response.ok;
  } catch {
    // Local logout still removes the credential. The dashboard can revoke the server grant.
  }
  await deleteCollectorCredential(config.credential);
  const next = removeCollectorDestination(rootConfig, destinationName);
  next.updatedAt = new Date().toISOString();
  writeCollectorConfig(next, resolved);
  return { removed: true, remoteRevoked };
}

export function parseOAuthCredential(value: string): CollectorOAuthTokenBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The saved collector OAuth credential is invalid. Run auth login again.");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.type !== "oauth") {
    throw new Error("The saved collector OAuth credential is invalid. Run auth login again.");
  }
  return {
    version: 1,
    type: "oauth",
    accessToken: requiredString(parsed.accessToken, "accessToken"),
    refreshToken: requiredString(parsed.refreshToken, "refreshToken"),
    expiresAt: requiredIsoDate(parsed.expiresAt, "expiresAt"),
    scope: requiredString(parsed.scope, "scope"),
  };
}

export function serializeOAuthCredential(bundle: CollectorOAuthTokenBundle): string {
  return JSON.stringify(bundle);
}

async function refreshOAuthCredential(
  config: CollectorConfig & CollectorDestination,
  current: CollectorOAuthTokenBundle,
  fetchImpl: typeof fetch,
  now: number,
): Promise<CollectorOAuthTokenBundle> {
  const response = await fetchImpl(`${config.serverUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: current.refreshToken,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "";
    if (code === "invalid_grant" || code === "access_denied") {
      throw new Error("Collector authorization expired or was revoked. Run auth login again.");
    }
    throw oauthResponseError("Could not refresh collector authorization", response.status, body);
  }
  return tokenBundle(body, now);
}

function tokenLoginResult(body: Record<string, unknown>, verificationUri: string, now: number) {
  const rawAuthorizations = Array.isArray(body.destinations) ? body.destinations : [body];
  const authorizations = rawAuthorizations.map((raw) => {
    if (!isRecord(raw)) throw new Error("The collector authorization response is invalid.");
    const bundle = tokenBundle(raw, now);
    const workspace = isRecord(raw.workspace) ? raw.workspace : {};
    const user = isRecord(raw.user) ? raw.user : {};
    return {
      bundle,
      scope: bundle.scope,
      workspace: {
        id: requiredString(workspace.id, "workspace.id"),
        name: requiredString(workspace.name, "workspace.name"),
        slug: typeof workspace.slug === "string" && workspace.slug ? workspace.slug : null,
      },
      user: { email: typeof user.email === "string" && user.email ? user.email : null },
    };
  });
  if (authorizations.length === 0) throw new Error("The collector authorization returned no workspaces.");
  return {
    verificationUri,
    authorizations,
  };
}

function tokenBundle(body: Record<string, unknown>, now: number): CollectorOAuthTokenBundle {
  const expiresIn = positiveInteger(body.expires_in, "expires_in");
  return {
    version: 1,
    type: "oauth",
    accessToken: requiredString(body.access_token, "access_token"),
    refreshToken: requiredString(body.refresh_token, "refresh_token"),
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    scope: requiredString(body.scope, "scope"),
  };
}

function tokenIsFresh(bundle: CollectorOAuthTokenBundle, now: number) {
  return new Date(bundle.expiresAt).getTime() - EXPIRY_SKEW_MS > now;
}

async function withRefreshLock<T>(
  configPath: string,
  destinationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = resolve(dirname(configPath), `.oauth-refresh-${destinationName}.lock`);
  const startedAt = Date.now();
  let handle: number | null = null;
  while (handle === null) {
    try {
      handle = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (refreshLockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
          continue;
        } catch {
          // Another process recovered the stale lock first.
        }
      }
      if (Date.now() - startedAt >= REFRESH_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for another collector process to refresh authorization.");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(handle);
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process can recover after the timeout if cleanup races with shutdown.
    }
  }
}

function refreshLockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs >= STALE_REFRESH_LOCK_MS;
  } catch {
    return false;
  }
}

function openSystemBrowser(url: string): boolean {
  try {
    const command =
      process.platform === "darwin"
        ? { file: "open", args: [url] }
        : process.platform === "win32"
          ? { file: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
          : { file: "xdg-open", args: [url] };
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function oauthResponseError(prefix: string, status: number, body: Record<string, unknown>) {
  const detail =
    typeof body.error_description === "string"
      ? body.error_description
      : typeof body.error === "string"
        ? body.error
        : `HTTP ${status}`;
  return new Error(`${prefix}: ${detail}`);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`OAuth response is missing ${field}.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`OAuth response has invalid ${field}.`);
  return parsed;
}

function requiredIsoDate(value: unknown, field: string): string {
  const string = requiredString(value, field);
  if (Number.isNaN(new Date(string).getTime())) throw new Error(`OAuth response has invalid ${field}.`);
  return string;
}

function requiredHttpsUrl(value: unknown, field: string): string {
  const string = requiredString(value, field);
  const url = new URL(string);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`OAuth response has unsafe ${field}.`);
  }
  return url.toString();
}

function optionalHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return requiredHttpsUrl(value, "verification_uri_complete");
}

function isLoopbackHost(hostnameValue: string) {
  return hostnameValue === "127.0.0.1" || hostnameValue === "::1" || hostnameValue === "localhost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameCredential(left: CollectorCredential, right: CollectorCredential): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
