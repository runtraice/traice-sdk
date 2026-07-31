import type { CollectorIdentity, CollectorSource, InternalUsageEvent, JsonRecord } from "@traice/protocol";

export type AgentName = "claude-code" | "codex";
export type CredentialStoreMode = "auto" | "keyring" | "file";

export type CollectorCredential =
  { backend: "os-keyring"; service: string; account: string } | { backend: "protected-file"; path: string };

export interface CollectorOAuthAuthorization {
  type: "oauth";
  clientId: "traice-collector";
  workspaceId: string;
  workspaceName: string;
  workspaceSlug?: string;
  userEmail?: string;
  scopes: string[];
  authorizedAt: string;
}

export interface CollectorDestination {
  serverUrl: string;
  credential?: CollectorCredential;
  authorization?: CollectorOAuthAuthorization;
  /** Optional attribution overrides applied only to events sent to this destination. */
  identity?: CollectorDestinationIdentity;
  /** Explicit, bounded context attached only to events sent to this destination. */
  context?: CollectorManualContext;
  /** Present only while a v1 plaintext credential is being migrated. */
  apiKey?: string;
}

export type CollectorDestinationIdentity = {
  [K in keyof CollectorIdentity]?: CollectorIdentity[K] | null;
};

export interface CollectorManualContext {
  role?: string;
  department?: string;
  description?: string;
  repository?: string;
  labels?: JsonRecord;
}

export interface CollectorConfig {
  version: 2;
  createdAt: string;
  updatedAt: string;
  destinations: Record<string, CollectorDestination>;
  /** Per-agent destination routes. */
  routes?: Partial<Record<AgentName, string[]>>;
  listenHost: string;
  listenPort: number;
  includePrompts: boolean;
  enabledAgents: AgentName[];
  identity: CollectorIdentity;
  sources: Partial<Record<AgentName, CollectorSource>>;
  /** First successful user-level telemetry configuration per agent. Backfill uses this as its safe default cutoff. */
  telemetryEnabledAt?: Partial<Record<AgentName, string>>;
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
  destination?: string;
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
  claudeHome?: string;
  codexHome?: string;
}

export interface CollectorRunOptions {
  configPath?: string;
  agent?: AgentName;
  once?: boolean;
  listenHost?: string;
  listenPort?: number;
  destinations?: string[];
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
