import { CostEvent } from "../types";

export interface TokenAbuseResult {
  userId: string;
  events: number;
  tokens: number;
  totalCostUSD: number;
  workspaceTokenSharePct: number;
  peerMedianTokens: number;
  peerMultiple: number;
  excessCostUSD: number;
  topFeature: string;
  topFeatureTokens: number;
  topTenantId?: string;
  severity: "warning" | "high";
}

export interface TokenAbuseOptions {
  /** Minimum distinct users before peer comparison is meaningful. Default: 3. */
  minUsers?: number;
  /** Minimum tokens for the user over the scanned event set. Default: 100,000. */
  minTokens?: number;
  /** Minimum user spend over the scanned event set. Default: 0. */
  minCostUSD?: number;
  /** Minimum share of all user-attributed tokens. Default: 25. */
  minWorkspaceSharePct?: number;
  /** Minimum multiple versus median user token volume. Default: 5. */
  minPeerMultiple?: number;
  /** Maximum rows to return. Default: 10. */
  maxResults?: number;
}

type UserAggregate = {
  userId: string;
  events: number;
  tokens: number;
  totalCostUSD: number;
  features: Map<string, number>;
  tenants: Map<string, number>;
};

const DEFAULT_OPTIONS: Required<TokenAbuseOptions> = {
  minUsers: 3,
  minTokens: 100_000,
  minCostUSD: 0,
  minWorkspaceSharePct: 25,
  minPeerMultiple: 5,
  maxResults: 10,
};

/**
 * Detects runaway token consumption by a single user in a set of metered events.
 *
 * This is peer-relative on purpose: a high-volume customer should not be flagged
 * only because they are big. A row is returned when one user consumes both a
 * large absolute token volume and a disproportionate share versus peers.
 */
export function detectTokenAbuse(events: CostEvent[], options: TokenAbuseOptions = {}): TokenAbuseResult[] {
  const opts = {
    minUsers: options.minUsers ?? DEFAULT_OPTIONS.minUsers,
    minTokens: options.minTokens ?? DEFAULT_OPTIONS.minTokens,
    minCostUSD: options.minCostUSD ?? DEFAULT_OPTIONS.minCostUSD,
    minWorkspaceSharePct: options.minWorkspaceSharePct ?? DEFAULT_OPTIONS.minWorkspaceSharePct,
    minPeerMultiple: options.minPeerMultiple ?? DEFAULT_OPTIONS.minPeerMultiple,
    maxResults: options.maxResults ?? DEFAULT_OPTIONS.maxResults,
  };
  const byUser = new Map<string, UserAggregate>();

  for (const event of events) {
    const userId = event.userId?.trim();
    if (!userId) continue;

    let aggregate = byUser.get(userId);
    if (!aggregate) {
      aggregate = {
        userId,
        events: 0,
        tokens: 0,
        totalCostUSD: 0,
        features: new Map(),
        tenants: new Map(),
      };
      byUser.set(userId, aggregate);
    }

    aggregate.events += 1;
    aggregate.tokens += safeNumber(event.totalTokens);
    aggregate.totalCostUSD += safeNumber(event.totalCostUSD);
    addToMap(aggregate.features, event.feature ?? "untagged", safeNumber(event.totalTokens));
    if (event.tenantId) {
      addToMap(aggregate.tenants, event.tenantId, safeNumber(event.totalTokens));
    }
  }

  const users = [...byUser.values()].filter((user) => user.tokens > 0);
  if (users.length < opts.minUsers) return [];

  const workspaceTokens = users.reduce((sum, user) => sum + user.tokens, 0);
  if (workspaceTokens <= 0) return [];

  const peerMedianTokens = median(users.map((user) => user.tokens));
  if (peerMedianTokens <= 0) return [];

  const results: TokenAbuseResult[] = [];
  for (const user of users) {
    if (user.tokens < opts.minTokens || user.totalCostUSD < opts.minCostUSD) continue;

    const workspaceTokenSharePct = (user.tokens / workspaceTokens) * 100;
    const peerMultiple = user.tokens / peerMedianTokens;
    if (workspaceTokenSharePct < opts.minWorkspaceSharePct || peerMultiple < opts.minPeerMultiple) {
      continue;
    }

    const [topFeature, topFeatureTokens] = topEntry(user.features);
    const [topTenantId] = topEntry(user.tenants);
    const excessShare = Math.max(0, (user.tokens - peerMedianTokens) / user.tokens);

    results.push({
      userId: user.userId,
      events: user.events,
      tokens: user.tokens,
      totalCostUSD: user.totalCostUSD,
      workspaceTokenSharePct: round(workspaceTokenSharePct, 1),
      peerMedianTokens,
      peerMultiple: round(peerMultiple, 1),
      excessCostUSD: user.totalCostUSD * excessShare,
      topFeature,
      topFeatureTokens,
      topTenantId: topTenantId || undefined,
      severity:
        workspaceTokenSharePct >= 40 || peerMultiple >= 10 || user.totalCostUSD >= Math.max(10, opts.minCostUSD * 4)
          ? "high"
          : "warning",
    });
  }

  return results.sort((a, b) => b.excessCostUSD - a.excessCostUSD || b.tokens - a.tokens).slice(0, opts.maxResults);
}

function safeNumber(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0;
}

function addToMap(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function topEntry(map: Map<string, number>): [string, number] {
  let topKey = "";
  let topValue = 0;
  for (const [key, value] of map.entries()) {
    if (value > topValue) {
      topKey = key;
      topValue = value;
    }
  }
  return [topKey, topValue];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
