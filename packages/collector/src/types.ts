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

export interface CollectorWorkspaceProfile {
  serverUrl: string;
  /** Optional only while a legacy default profile still contains a plaintext apiKey. */
  credential?: CollectorCredential;
  authorization?: CollectorOAuthAuthorization;
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
  /** Additional workspace-scoped destinations. The legacy top-level destination is named "default". */
  profiles?: Record<string, CollectorWorkspaceProfile>;
  /** Primary destination for live collection. Defaults to the legacy "default" destination. */
  activeProfile?: string;
  /** Explicit best-effort copies after the primary destination succeeds. */
  mirrorProfiles?: string[];
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
  profile?: string;
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
  profile?: string;
  mirrorProfiles?: string[];
}

export interface OtlpNormalizeOptions {
  source: CollectorSource;
  identity: CollectorIdentity;
  receivedAt?: string;
  includePrompts?: boolean;
}

export interface AgentAdapter {
  name: AgentName;
  normalizeLogs(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[];
  normalizeMetrics?(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[];
}
