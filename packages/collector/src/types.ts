import type { CollectorIdentity, CollectorSource, InternalUsageEvent } from "@traice/protocol";

export type AgentName = "claude-code" | "codex";
export type CredentialStoreMode = "auto" | "keyring" | "file";

export type CollectorCredential =
  { backend: "os-keyring"; service: string; account: string } | { backend: "protected-file"; path: string };

export interface CollectorOAuthAuthorization {
  type: "oauth";
  clientId: "traice-collector";
  workspaceId: string;
  workspaceName: string;
  userEmail?: string;
  scopes: string[];
  authorizedAt: string;
}

export interface CollectorConfig {
  version: 1;
  createdAt: string;
  updatedAt: string;
  serverUrl: string;
  /** @deprecated Migrated to credential on the next install or collect. */
  apiKey?: string;
  credential?: CollectorCredential;
  authorization?: CollectorOAuthAuthorization;
  listenHost: string;
  listenPort: number;
  includePrompts: boolean;
  enabledAgents: AgentName[];
  identity: CollectorIdentity;
  sources: Partial<Record<AgentName, CollectorSource>>;
  claudeHome?: string;
  codexHome?: string;
}

export interface CollectorInstallOptions {
  agent: AgentName;
  configPath?: string;
  serverUrl?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  credentialStore?: CredentialStoreMode;
  noBrowser?: boolean;
  workspaceHint?: string;
  employeeEmail?: string;
  employeeName?: string;
  employeeExternalId?: string;
  teamName?: string;
  teamExternalId?: string;
  sourcePrincipal?: string;
  seatMonthlyUsd?: number;
  listenHost?: string;
  listenPort?: number;
  includePrompts?: boolean;
  patchSettings?: boolean;
  launchAgent?: boolean;
  claudeHome?: string;
  codexHome?: string;
}

export interface CollectorRunOptions {
  configPath?: string;
  agent?: AgentName;
  once?: boolean;
  listenHost?: string;
  listenPort?: number;
}

export interface OtlpNormalizeOptions {
  source: CollectorSource;
  identity: CollectorIdentity;
  receivedAt?: string;
}

export interface AgentAdapter {
  name: AgentName;
  normalizeLogs(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[];
  normalizeMetrics?(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[];
}
