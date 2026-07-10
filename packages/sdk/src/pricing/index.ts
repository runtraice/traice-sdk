import { PricingTable } from "../types";
import openaiPricing from "./openai.json";
import anthropicPricing from "./anthropic.json";

const pricingTables: Record<string, PricingTable> = {
  openai: { ...(openaiPricing as PricingTable) },
  anthropic: { ...(anthropicPricing as PricingTable) },
};

const CACHE_MULTIPLIERS: Record<string, { read: number; write: number }> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.5, write: 1 },
};

// Track models we've already warned about to avoid spam (capped to prevent memory leak)
const MAX_WARNED = 1000;
const warnedModels = new Set<string>();

let onUnknownModel: ((provider: string, model: string) => void) | null = null;

export function setUnknownModelHandler(handler: ((provider: string, model: string) => void) | null): void {
  onUnknownModel = handler;
}

function trackWarned(key: string, provider: string, model: string): void {
  if (warnedModels.has(key)) return;
  if (warnedModels.size >= MAX_WARNED) warnedModels.clear();
  warnedModels.add(key);
  if (onUnknownModel) onUnknownModel(provider, model);
}

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): { inputCostUSD: number; outputCostUSD: number; totalCostUSD: number } {
  const table = pricingTables[provider];
  if (!table) {
    if (provider !== "custom") {
      trackWarned(`${provider}/${model}`, provider, model);
    }
    return { inputCostUSD: 0, outputCostUSD: 0, totalCostUSD: 0 };
  }

  const pricing = table[model];
  if (!pricing) {
    trackWarned(`${provider}/${model}`, provider, model);
    return { inputCostUSD: 0, outputCostUSD: 0, totalCostUSD: 0 };
  }

  const cache = normalizeCacheTokens(inputTokens, cacheReadTokens, cacheWriteTokens);
  const multipliers = CACHE_MULTIPLIERS[provider] ?? { read: 1, write: 1 };
  const inputCostUSD =
    (cache.regularInputTokens / 1_000_000) * pricing.input +
    (cache.cacheReadTokens / 1_000_000) * pricing.input * multipliers.read +
    (cache.cacheWriteTokens / 1_000_000) * pricing.input * multipliers.write;
  const outputCostUSD = (outputTokens / 1_000_000) * pricing.output;
  const totalCostUSD = inputCostUSD + outputCostUSD;

  return { inputCostUSD, outputCostUSD, totalCostUSD };
}

export function normalizeCacheTokens(
  inputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): { regularInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const input = Math.max(0, Math.floor(inputTokens));
  let read = Math.max(0, Math.floor(cacheReadTokens));
  let write = Math.max(0, Math.floor(cacheWriteTokens));
  const cacheTotal = read + write;
  if (cacheTotal > input && cacheTotal > 0) {
    const scale = input / cacheTotal;
    read = Math.floor(read * scale);
    write = Math.min(input - read, Math.floor(write * scale));
  }
  return {
    regularInputTokens: Math.max(0, input - read - write),
    cacheReadTokens: read,
    cacheWriteTokens: write,
  };
}

/**
 * Add or update pricing for a model.
 */
export function configurePricing(provider: string, model: string, pricing: { input: number; output: number }): void {
  if (!pricingTables[provider]) {
    pricingTables[provider] = {};
  }
  pricingTables[provider][model] = {
    input: pricing.input,
    output: pricing.output,
    unit: "per_million_tokens",
  };
}

/**
 * Remove pricing for a specific model. Returns true if the model existed.
 */
export function removePricing(provider: string, model: string): boolean {
  const table = pricingTables[provider];
  if (!table || !table[model]) return false;
  delete table[model];
  return true;
}

/**
 * Set pricing for an entire provider at once.
 */
export function setPricingTable(provider: string, table: PricingTable): void {
  pricingTables[provider] = { ...table };
}

export function getAvailableModels(provider: string): string[] {
  const table = pricingTables[provider];
  return table ? Object.keys(table) : [];
}

/**
 * Returns a deep copy of all pricing tables. Mutations to the returned
 * object do not affect the internal state.
 */
export function getAllPricing(): Record<string, PricingTable> {
  return JSON.parse(JSON.stringify(pricingTables));
}
