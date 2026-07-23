import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { readJsonFile } from "./fs";
import type { CollectorCredential, CredentialStoreMode } from "./types";

const KEYRING_SERVICE = "trAIce Collector";

interface KeyringEntry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined>;
  deletePassword?(): Promise<unknown>;
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
      await setKeyringPassword(entry, apiKey);
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
    if (!apiKey) {
      throw new Error("Collector credential was not found in the OS credential store. Run setup or auth login.");
    }
    return apiKey;
  }

  const stored = readJsonFile<{ apiKey?: string }>(credential.path);
  if (!stored?.apiKey) {
    throw new Error(`Collector credential was not found in ${credential.path}. Run setup or auth login.`);
  }
  return stored.apiKey;
}

export async function writeCollectorCredential(
  credential: CollectorCredential,
  value: string,
  dependencies: CredentialStoreDependencies = {},
): Promise<void> {
  if (credential.backend === "os-keyring") {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(credential.service, credential.account);
    await setKeyringPassword(entry, value);
    return;
  }
  writeProtectedCredentialFile(credential.path, value);
}

export async function deleteCollectorCredential(
  credential: CollectorCredential,
  dependencies: CredentialStoreDependencies = {},
): Promise<void> {
  if (credential.backend === "os-keyring") {
    const entry = (dependencies.createKeyringEntry ?? createNativeEntry)(credential.service, credential.account);
    await entry.deletePassword?.();
    return;
  }
  rmSync(credential.path, { force: true });
}

export function credentialAccount(configPath: string): string {
  return `config-${createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 24)}`;
}

function createNativeEntry(service: string, account: string): KeyringEntry {
  const entry = new AsyncEntry(service, account);
  return {
    setPassword: (password) => entry.setPassword(password),
    getPassword: () => entry.getPassword(),
    deletePassword: () => entry.deletePassword(),
  };
}

async function setKeyringPassword(entry: KeyringEntry, value: string): Promise<void> {
  try {
    await entry.setPassword(value);
  } catch (error) {
    if (!entry.deletePassword || !/already exists/i.test(errorMessage(error))) throw error;
    await entry.deletePassword();
    await entry.setPassword(value);
  }
  if ((await entry.getPassword()) !== value) throw new Error("credential verification failed");
}

function writeProtectedFile(configPath: string, apiKey: string): CollectorCredential {
  const directory = dirname(resolve(configPath));
  const path = resolve(directory, "credentials.json");
  writeProtectedCredentialFile(path, apiKey);
  return { backend: "protected-file", path };
}

function writeProtectedCredentialFile(path: string, value: string): void {
  const directory = dirname(resolve(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows uses the ACL inherited from the user's profile directory.
  }
  writeFileSync(path, `${JSON.stringify({ apiKey: value }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
