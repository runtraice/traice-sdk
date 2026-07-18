import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { readJsonFile } from "./fs";
import type { CollectorCredential, CredentialStoreMode } from "./types";

const KEYRING_SERVICE = "trAIce Collector";

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
}

export interface CredentialStoreDependencies {
  createKeyringEntry?: (service: string, account: string) => KeyringEntry;
}

export interface StoredCredentialResult {
  credential: CollectorCredential;
  warning?: string;
}

export async function storeCollectorCredential(
  configPath: string,
  apiKey: string,
  mode: CredentialStoreMode = "auto",
  dependencies: CredentialStoreDependencies = {},
): Promise<StoredCredentialResult> {
  const account = credentialAccount(configPath);
  if (mode !== "file") {
    try {
      const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(KEYRING_SERVICE, account);
      await entry.setPassword(apiKey);
      if ((await entry.getPassword()) !== apiKey) throw new Error("credential verification failed");
      return { credential: { backend: "os-keyring", service: KEYRING_SERVICE, account } };
    } catch (error) {
      if (mode === "keyring") {
        throw new Error(`OS credential store unavailable: ${errorMessage(error)}`);
      }
      const credential = writeProtectedFile(configPath, apiKey);
      return {
        credential,
        warning: `OS credential store unavailable; using a user-only protected file (${errorMessage(error)}).`,
      };
    }
  }

  return { credential: writeProtectedFile(configPath, apiKey) };
}

export async function readCollectorCredential(
  credential: CollectorCredential,
  dependencies: CredentialStoreDependencies = {},
): Promise<string> {
  if (credential.backend === "os-keyring") {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(credential.service, credential.account);
    const apiKey = await entry.getPassword();
    if (!apiKey) throw new Error("Collector API key was not found in the OS credential store. Re-run install.");
    return apiKey;
  }

  const stored = readJsonFile<{ apiKey?: string }>(credential.path);
  if (!stored?.apiKey) throw new Error(`Collector API key was not found in ${credential.path}. Re-run install.`);
  return stored.apiKey;
}

export function credentialAccount(configPath: string): string {
  return `config-${createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 24)}`;
}

function createNativeEntry(service: string, account: string): KeyringEntry {
  const entry = new AsyncEntry(service, account);
  return {
    setPassword: (password) => entry.setPassword(password),
    getPassword: () => entry.getPassword(),
  };
}

function writeProtectedFile(configPath: string, apiKey: string): CollectorCredential {
  const directory = dirname(resolve(configPath));
  const path = resolve(directory, "credentials.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows uses the ACL inherited from the user's profile directory.
  }
  writeFileSync(path, `${JSON.stringify({ apiKey }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return { backend: "protected-file", path };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
