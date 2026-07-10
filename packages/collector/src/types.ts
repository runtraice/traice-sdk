import type { CollectorIdentity, CollectorSource, InternalUsageEvent } from "@traice/protocol";

export type AgentName = "claude-code" | "codex";

export interface CollectorConfig {
  version: 1;
  createdAt: string;
  updatedAt: string;
  serverUrl: string;
  apiKey?: string;
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
