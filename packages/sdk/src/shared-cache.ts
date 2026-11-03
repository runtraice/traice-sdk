import * as crypto from "crypto";

/**
 * Shared exact cache key contract, version `shared-exact-v1`.
 *
 * When a workspace owner opts in, SDK instances of one workspace can share
 * CACHE_EXACT answers through TrAIce. The request itself never leaves the
 * process: the SDK sends only a key, the lowercase hex HMAC-SHA256 of
 * `sharedExactCacheKeyInput(ruleId, request)` keyed with the workspace's cache
 * key salt from `GET /api/v1/rules`. The canonical form matches the server's
 * `@traice/enforce` builder, which the conformance fixtures prove.
 */
export const SHARED_EXACT_CACHE_KEY_VERSION = "shared-exact-v1";

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, `undefined`
 * members dropped, array order kept, and everything else as `JSON.stringify`
 * writes it. Code-unit order (not `localeCompare`) keeps keys identical across
 * runtimes and locales.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalize(item)));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareCodeUnits)) {
      if (record[key] !== undefined) sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The text the SDK HMACs to key one cached response: the rule and the complete provider request. */
export function sharedExactCacheKeyInput(ruleId: string, request: unknown): string {
  return canonicalJson({ v: SHARED_EXACT_CACHE_KEY_VERSION, ruleId, request });
}

/** The shared cache key for one request under one rule. */
export function sharedExactCacheKey(keySalt: string, ruleId: string, request: unknown): string {
  return crypto.createHmac("sha256", keySalt).update(sharedExactCacheKeyInput(ruleId, request)).digest("hex");
}
