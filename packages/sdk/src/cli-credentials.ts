import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { DEFAULT_TRAICE_SERVER_URL, normalizeServerUrl } from "./ask";

const KEYRING_SERVICE = "trAIce CLI";
export const DEFAULT_CLI_CONFIG_PATH = resolve(homedir(), ".traice", "cli", "config.json");

type KeyringCredential = { backend: "os-keyring"; service: string; account: string };
type FileCredential = { backend: "protected-file"; path: string };
type CliCredential = KeyringCredential | FileCredential;
type CliConfig = { version: 1; serverUrl: string; credential: CliCredential };

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deletePassword(): Promise<unknown>;
}

export type CliCredentialDependencies = {
  createKeyringEntry?: (service: string, account: string) => KeyringEntry;
};

export async function storeCliCredential(
  apiKey: string,
  serverUrl = DEFAULT_TRAICE_SERVER_URL,
  configPath = DEFAULT_CLI_CONFIG_PATH,
  dependencies: CliCredentialDependencies = {},
): Promise<{ backend: CliCredential["backend"]; warning?: string }> {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const account = credentialAccount(normalizedServerUrl);
  let credential: CliCredential;
  let warning: string | undefined;

  try {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(KEYRING_SERVICE, account);
    await entry.setPassword(apiKey);
    if ((await entry.getPassword()) !== apiKey) throw new Error("credential verification failed");
    credential = { backend: "os-keyring", service: KEYRING_SERVICE, account };
  } catch (error) {
    credential = writeProtectedCredential(configPath, apiKey);
    warning = `OS credential store unavailable; using a user-only protected file (${errorMessage(error)}).`;
  }

  writePrivateJson(configPath, { version: 1, serverUrl: normalizedServerUrl, credential } satisfies CliConfig);
  return { backend: credential.backend, ...(warning ? { warning } : {}) };
}

export async function resolveCliCredential(
  serverUrlOverride?: string,
  configPath = DEFAULT_CLI_CONFIG_PATH,
  dependencies: CliCredentialDependencies = {},
): Promise<{ apiKey: string; serverUrl: string; source: "environment" | CliCredential["backend"] }> {
  const envKey = process.env.TRAICE_API_KEY?.trim();
  const config = readJson<CliConfig>(configPath);
  const serverUrl = normalizeServerUrl(
    serverUrlOverride ?? process.env.TRAICE_SERVER_URL ?? config?.serverUrl ?? DEFAULT_TRAICE_SERVER_URL,
  );
  if (envKey) return { apiKey: envKey, serverUrl, source: "environment" };
  if (!config) throw new Error('No saved trAIce credential. Set TRAICE_API_KEY once and run "traice auth login".');
  if (serverUrlOverride && serverUrl !== config.serverUrl) {
    throw new Error(`No saved trAIce credential for ${serverUrl}. Run "traice auth login --server-url ${serverUrl}".`);
  }

  if (config.credential.backend === "os-keyring") {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(
      config.credential.service,
      config.credential.account,
    );
    const apiKey = await entry.getPassword();
    if (!apiKey) throw new Error('Saved trAIce credential is missing. Run "traice auth login" again.');
    return { apiKey, serverUrl, source: "os-keyring" };
  }

  const stored = readJson<{ apiKey?: string }>(config.credential.path);
  if (!stored?.apiKey) throw new Error('Saved trAIce credential is missing. Run "traice auth login" again.');
  return { apiKey: stored.apiKey, serverUrl, source: "protected-file" };
}

export async function deleteCliCredential(
  configPath = DEFAULT_CLI_CONFIG_PATH,
  dependencies: CliCredentialDependencies = {},
): Promise<boolean> {
  const config = readJson<CliConfig>(configPath);
  if (!config) return false;
  if (config.credential.backend === "os-keyring") {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(
      config.credential.service,
      config.credential.account,
    );
    await entry.deletePassword().catch(() => undefined);
  } else {
    rmSync(config.credential.path, { force: true });
  }
  rmSync(configPath, { force: true });
  return true;
}

export function credentialAccount(serverUrl: string): string {
  return `server-${createHash("sha256").update(serverUrl).digest("hex").slice(0, 24)}`;
}

function createNativeEntry(service: string, account: string): KeyringEntry {
  const entry = new AsyncEntry(service, account);
  return {
    setPassword: (password) => entry.setPassword(password),
    getPassword: () => entry.getPassword(),
    deletePassword: () => entry.deletePassword(),
  };
}

function writeProtectedCredential(configPath: string, apiKey: string): FileCredential {
  const path = resolve(dirname(configPath), "credentials.json");
  writePrivateJson(path, { apiKey });
  return { backend: "protected-file", path };
}

function writePrivateJson(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows protects files with the current user's inherited ACL.
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
