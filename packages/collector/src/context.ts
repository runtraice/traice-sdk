import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { CollectorIdentity, InternalUsageEvent, JsonRecord, JsonValue } from "@traice/protocol";
import { redactMetadata } from "@traice/protocol";
import { collectorDestination, normalizeDestinationName } from "./destinations";
import type { CollectorConfig, CollectorDestinationIdentity, CollectorManualContext } from "./types";

export const COLLECTOR_CONTEXT_LIMITS = {
  descriptionChars: 280,
  repositoryChars: 200,
  roleChars: 80,
  departmentChars: 80,
  labelsBytes: 2 * 1024,
  labelsKeys: 24,
  labelsDepth: 3,
  labelStringChars: 256,
  labelArrayItems: 20,
  totalBytes: 4 * 1024,
} as const;

export type CollectorContextPatch = {
  identity?: CollectorDestinationIdentity;
  context?: CollectorManualContext;
};

export function updateCollectorDestinationContext(
  config: CollectorConfig,
  requestedDestination: string,
  patch: CollectorContextPatch,
): CollectorConfig {
  const name = normalizeDestinationName(requestedDestination);
  const destination = collectorDestination(config, name);
  const identity = normalizeIdentityPatch({ ...destination.identity, ...patch.identity });
  const context = normalizeCollectorManualContext({ ...destination.context, ...patch.context });
  return {
    ...config,
    destinations: {
      ...config.destinations,
      [name]: {
        ...destination,
        ...(Object.keys(identity).length > 0 ? { identity } : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
      },
    },
  };
}

export function clearCollectorDestinationContext(
  config: CollectorConfig,
  requestedDestination: string,
  includeIdentity = false,
): CollectorConfig {
  const name = normalizeDestinationName(requestedDestination);
  const destination = { ...collectorDestination(config, name) };
  delete destination.context;
  if (includeIdentity) delete destination.identity;
  return { ...config, destinations: { ...config.destinations, [name]: destination } };
}

export function eventForCollectorDestination(
  config: CollectorConfig,
  requestedDestination: string,
  event: InternalUsageEvent,
  options: { includeTaskContext?: boolean } = {},
): InternalUsageEvent {
  const destination = collectorDestination(config, requestedDestination);
  const enriched = { ...event };
  applyIdentityOverride(enriched, destination.identity);

  const context = destination.context;
  if (!context || Object.keys(context).length === 0) return enriched;
  const metadata: JsonRecord = { ...(event.metadata ?? {}) };
  if (context.role) metadata.role = context.role;
  if (context.department) metadata.department = context.department;
  if (options.includeTaskContext !== false && (context.description || context.repository || context.labels)) {
    metadata.task = {
      ...(context.description ? { description: context.description } : {}),
      ...(context.repository ? { repository: context.repository } : {}),
      ...(context.labels ? { labels: context.labels } : {}),
    };
  }
  enriched.metadata = metadata;
  return enriched;
}

export function collectorDestinationContextSummary(config: CollectorConfig, requestedDestination: string) {
  const name = normalizeDestinationName(requestedDestination);
  const destination = collectorDestination(config, name);
  return {
    destination: name,
    identity: effectiveCollectorIdentity(config.identity, destination.identity),
    context: destination.context ?? {},
  };
}

export function effectiveCollectorIdentity(
  base: CollectorIdentity,
  override?: CollectorDestinationIdentity,
): CollectorIdentity {
  const identity = { ...base };
  applyIdentityOverride(identity, override);
  return identity;
}

export function parseContextLabels(value: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--labels-json must be a valid JSON object.");
  }
  return normalizeLabels(parsed);
}

export function resolveRepositoryLabel(cwd = process.cwd()): string {
  const remote = gitValue(["config", "--get", "remote.origin.url"], cwd);
  const remoteLabel = remote ? repositoryFromRemote(remote) : undefined;
  if (remoteLabel) return boundedString(remoteLabel, "repository", COLLECTOR_CONTEXT_LIMITS.repositoryChars);
  const root = gitValue(["rev-parse", "--show-toplevel"], cwd);
  if (!root)
    throw new Error('Could not infer a Git repository. Pass an explicit value instead of "--repository auto".');
  return boundedString(basename(root), "repository", COLLECTOR_CONTEXT_LIMITS.repositoryChars);
}

export function normalizeCollectorManualContext(value: CollectorManualContext): CollectorManualContext {
  const normalized: CollectorManualContext = {
    ...(value.role ? { role: boundedString(value.role, "role", COLLECTOR_CONTEXT_LIMITS.roleChars) } : {}),
    ...(value.department
      ? { department: boundedString(value.department, "department", COLLECTOR_CONTEXT_LIMITS.departmentChars) }
      : {}),
    ...(value.description
      ? {
          description: boundedString(value.description, "description", COLLECTOR_CONTEXT_LIMITS.descriptionChars),
        }
      : {}),
    ...(value.repository
      ? {
          repository: boundedString(value.repository, "repository", COLLECTOR_CONTEXT_LIMITS.repositoryChars),
        }
      : {}),
    ...(value.labels ? { labels: normalizeLabels(value.labels) } : {}),
  };
  const bytes = byteLength(JSON.stringify(normalized));
  if (bytes > COLLECTOR_CONTEXT_LIMITS.totalBytes) {
    throw new Error(`Collector context may contain at most ${COLLECTOR_CONTEXT_LIMITS.totalBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function normalizeIdentityPatch(value: CollectorDestinationIdentity): CollectorDestinationIdentity {
  const normalized: CollectorDestinationIdentity = {};
  for (const key of identityKeys) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (raw === null) {
      normalized[key] = null;
      continue;
    }
    if (key === "seatMonthlyUsd") {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
        throw new Error("seatMonthlyUsd must be a non-negative number.");
      }
      normalized.seatMonthlyUsd = raw;
      continue;
    }
    const text = boundedString(String(raw), key, key === "employeeEmail" ? 254 : 256);
    if (key === "employeeEmail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      throw new Error("employeeEmail must be a valid email address.");
    }
    Object.assign(normalized, { [key]: key === "employeeEmail" ? text.toLowerCase() : text });
  }
  return normalized;
}

function normalizeLabels(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("Collector context labels must be a JSON object.");
  let keys = 0;
  const normalized = normalizeLabelValue(value, 0, () => {
    keys += 1;
    if (keys > COLLECTOR_CONTEXT_LIMITS.labelsKeys) {
      throw new Error(`Collector context labels may contain at most ${COLLECTOR_CONTEXT_LIMITS.labelsKeys} keys.`);
    }
  });
  if (!isRecord(normalized)) throw new Error("Collector context labels must be a JSON object.");
  const redacted = redactMetadata(normalized);
  if (!isRecord(redacted)) throw new Error("Collector context labels must be a JSON object.");
  const bytes = byteLength(JSON.stringify(redacted));
  if (bytes > COLLECTOR_CONTEXT_LIMITS.labelsBytes) {
    throw new Error(
      `Collector context labels may contain at most ${COLLECTOR_CONTEXT_LIMITS.labelsBytes} UTF-8 bytes.`,
    );
  }
  return redacted;
}

function normalizeLabelValue(value: unknown, depth: number, onKey: () => void): JsonValue {
  if (depth > COLLECTOR_CONTEXT_LIMITS.labelsDepth) {
    throw new Error(`Collector context labels may be nested at most ${COLLECTOR_CONTEXT_LIMITS.labelsDepth} levels.`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Collector context label numbers must be finite.");
    return value;
  }
  if (typeof value === "string") {
    return boundedString(value, "label string", COLLECTOR_CONTEXT_LIMITS.labelStringChars);
  }
  if (Array.isArray(value)) {
    if (value.length > COLLECTOR_CONTEXT_LIMITS.labelArrayItems) {
      throw new Error(
        `Collector context label arrays may contain at most ${COLLECTOR_CONTEXT_LIMITS.labelArrayItems} items.`,
      );
    }
    return value.map((item) => normalizeLabelValue(item, depth + 1, onKey));
  }
  if (!isRecord(value)) throw new Error("Collector context labels must contain only JSON values.");
  const output: JsonRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error(`Collector context label key "${key}" is not allowed.`);
    }
    onKey();
    output[boundedString(key, "label key", 64)] = normalizeLabelValue(nested, depth + 1, onKey);
  }
  return output;
}

function applyIdentityOverride(
  target: CollectorIdentity | InternalUsageEvent,
  override?: CollectorDestinationIdentity,
): void {
  if (!override) return;
  for (const key of identityKeys) {
    const value = override[key];
    if (value === undefined) continue;
    if (value === null) delete target[key];
    else Object.assign(target, { [key]: value });
  }
}

const identityKeys = [
  "employeeEmail",
  "employeeName",
  "employeeExternalId",
  "teamName",
  "teamExternalId",
  "sourcePrincipal",
  "seatMonthlyUsd",
] as const;

function repositoryFromRemote(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/, "");
  const scp = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const path =
    scp?.[1] ??
    (() => {
      try {
        return new URL(trimmed).pathname.replace(/^\/+/, "");
      } catch {
        return undefined;
      }
    })();
  if (!path) return undefined;
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : parts[0];
}

function gitValue(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000 });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || undefined;
}

function boundedString(value: string, field: string, maxChars: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${field} may contain at most ${maxChars} characters.`);
  return normalized;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
