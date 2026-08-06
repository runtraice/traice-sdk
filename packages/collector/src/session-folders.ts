import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { canonicalFolderPath } from "./destinations";
import { resolveHome } from "./fs";
import type { AgentName, CollectorConfig } from "./types";

const HEADER_BYTES = 256 * 1024;
const MISSING_CACHE_MS = 2_000;

type SessionFolderCacheEntry = { folder?: string; checkedAt: number };

export class CollectorSessionFolderResolver {
  private readonly cache = new Map<string, SessionFolderCacheEntry>();
  private readonly filesByAgent = new Map<AgentName, Map<string, string>>();
  private readonly indexedAt = new Map<AgentName, number>();

  constructor(private readonly config: Pick<CollectorConfig, "claudeHome" | "codexHome">) {}

  resolve(agent: AgentName, sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const key = `${agent}:${sessionId}`;
    const cached = this.cache.get(key);
    if (cached?.folder || (cached && Date.now() - cached.checkedAt < MISSING_CACHE_MS)) return cached.folder;

    let file = this.sessionFiles(agent).get(sessionId);
    if (!file && Date.now() - (this.indexedAt.get(agent) ?? 0) >= MISSING_CACHE_MS) {
      this.filesByAgent.delete(agent);
      file = this.sessionFiles(agent).get(sessionId);
    }
    const folder = file ? sessionFolderFromFile(agent, file, sessionId) : undefined;
    this.cache.set(key, { ...(folder ? { folder } : {}), checkedAt: Date.now() });
    return folder;
  }

  private sessionFiles(agent: AgentName): Map<string, string> {
    const existing = this.filesByAgent.get(agent);
    if (existing) return existing;
    const root =
      agent === "codex"
        ? resolve(resolveHome(this.config.codexHome ?? "~/.codex"), "sessions")
        : resolve(resolveHome(this.config.claudeHome ?? "~/.claude"), "projects");
    const files = new Map<string, string>();
    for (const file of jsonlFiles(root)) {
      const name = basename(file, extname(file));
      if (agent === "claude-code") {
        files.set(name, file);
        continue;
      }
      const match = name.match(/([0-9a-f]{8}-[0-9a-f-]{27,})$/i);
      if (match?.[1]) files.set(match[1], file);
    }
    this.filesByAgent.set(agent, files);
    this.indexedAt.set(agent, Date.now());
    return files;
  }
}

export function sessionFolderFromFile(agent: AgentName, file: string, expectedSessionId?: string): string | undefined {
  for (const line of readJsonlHeader(file).split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = asRecord(row.payload);
    const sessionId =
      agent === "codex" ? (stringValue(payload?.id) ?? stringValue(payload?.session_id)) : stringValue(row.sessionId);
    const cwd = agent === "codex" ? stringValue(payload?.cwd) : stringValue(row.cwd);
    if (expectedSessionId && sessionId && sessionId !== expectedSessionId) continue;
    if (cwd) return canonicalFolderPath(cwd);
  }
  return undefined;
}

function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  };
  visit(root);
  return files;
}

function readJsonlHeader(file: string): string {
  const descriptor = openSync(file, "r");
  try {
    const size = Math.min(HEADER_BYTES, fstatSync(descriptor).size);
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(descriptor, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
