export type EventMetadata = Record<string, unknown>;

export interface CostEvent {
  id: string;
  timestamp: string;
  /** Provider identifier, for example openai, anthropic, or google-vertex. */
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Prompt tokens served from a provider prompt cache. Subset of inputTokens. */
  cacheReadTokens?: number;
  /** Prompt tokens written into a provider prompt cache. Subset of inputTokens. */
  cacheWriteTokens?: number;
  inputCostUSD: number;
  outputCostUSD: number;
  totalCostUSD: number;
  latencyMs: number;
  status?: "success" | "error";
  errorMessage?: string;
  cached?: boolean;
  promptName?: string;
  promptVersion?: string;
  feature?: string;
  userId?: string;
  /** Paying customer/account identifier. */
  tenantId?: string;
  /** Agent identifier for multi-agent applications. */
  agentId?: string;
  /** Workflow identifier that groups related runs. */
  workflowId?: string;
  /** Run/execution identifier for an agent or workflow. */
  runId?: string;
  /** Step identifier within a workflow/run. */
  stepId?: string;
  /** Tool name for agent/tool-call attribution. */
  toolName?: string;
  /** Retry attempt count for this call. */
  retryCount?: number;
  /** Product or workflow outcome label, e.g. success, error, timeout. */
  outcome?: string;
  sessionId?: string;
  env?: string;
  /** Optional prompt text for cloud sample capture when the workspace opts in. */
  prompt?: string;
  /** Optional output text for cloud sample capture when the workspace opts in. */
  output?: string;
  /** Arbitrary structured metadata. Use tags for legacy string key/value data. */
  metadata?: EventMetadata;
  /** Legacy string key/value metadata. Preserved for backward compatibility. */
  tags?: Record<string, string>;
}

export type ErrorHandler = (error: Error, event?: CostEvent) => void;

export interface MeterOptions {
  /** Explicit provider identifier for responses whose shape cannot identify the provider. */
  provider?: string;
  feature?: string;
  userId?: string;
  tenantId?: string;
  agentId?: string;
  workflowId?: string;
  runId?: string;
  stepId?: string;
  toolName?: string;
  retryCount?: number;
  outcome?: string;
  sessionId?: string;
  env?: string;
  prompt?: string;
  output?: string;
  metadata?: EventMetadata;
  tags?: Record<string, string>;
  promptName?: string;
  promptVersion?: string;
  /** If true, await adapter writes before returning. Default: false (fire-and-forget). */
  awaitWrites?: boolean;
}

export interface CostMeterConfig {
  provider?: string;
  adapters?: Array<string | CostAdapter>;
  localPath?: string;
  defaultTags?: Record<string, string>;
  currency?: string;
  verbose?: boolean;
  /** Called when an adapter write fails. If not set, errors are logged when verbose=true. */
  onError?: ErrorHandler;
}

export interface GlobalConfig {
  adapters: Array<string | CostAdapter>;
  localPath: string;
  defaultTags: Record<string, string>;
  currency: string;
  verbose: boolean;
  /** Called when an adapter write fails. If not set, errors are logged when verbose=true. */
  onError?: ErrorHandler;
  /** If true, warn to console when a model is not found in the pricing table. Default: true. */
  warnOnMissingModel: boolean;
  /** API key for the trAIce cloud service. Get one at https://runtraice.com */
  cloudApiKey?: string;
  /** Cloud API endpoint. Default: https://runtraice.com/api/v1/events */
  cloudEndpoint?: string;
}

export interface CostAdapter {
  name: string;
  write(event: CostEvent): Promise<void>;
  /** Optional cleanup method called on flush/shutdown. */
  flush?(): Promise<void>;
}

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  unit: string;
}

export interface PricingTable {
  [model: string]: ModelPricing;
}

export interface SummaryRow {
  key: string;
  calls: number;
  totalTokens: number;
  avgCostPerCall: number;
  totalCost: number;
}

export interface ReportOptions {
  groupBy?: string;
  feature?: string;
  env?: string;
  userId?: string;
  from?: string;
  to?: string;
  top?: number;
  format?: "table" | "csv" | "json";
  file?: string;
}

export interface MeterStats {
  eventsTracked: number;
  eventsDropped: number;
  adapterErrors: number;
  unknownModels: Set<string>;
}

// ── Express Middleware Types ────────────────────────────────────

export interface ExpressMiddlewareOptions {
  feature: string;
  extractUserId?: (req: any) => string | undefined;
  extractSessionId?: (req: any) => string | undefined;
  env?: string;
  tags?: Record<string, string>;
}

// ── Webhook Adapter Types ──────────────────────────────────────

export interface WebhookAdapterConfig {
  url: string;
  headers?: Record<string, string>;
  /** Number of events to buffer before sending. Default: 1 (immediate). */
  batchSize?: number;
  /** Flush buffer interval in ms. Only used when batchSize > 1. Default: 5000. */
  flushIntervalMs?: number;
  /** Request timeout in ms. Default: 10000. */
  timeoutMs?: number;
}

// ── OpenTelemetry Adapter Types ────────────────────────────────

export interface OTelAdapterConfig {
  /** OpenTelemetry meter name. Default: 'traice-sdk'. */
  meterName?: string;
}

// ── Budget Alert Types ─────────────────────────────────────────

export interface BudgetRule {
  /** Feature name to monitor, or '*' for global (all features). */
  feature: string;
  /** Maximum daily spend in USD. */
  dailyLimitUSD: number;
  /** Called once per day when the limit is exceeded. */
  onExceed: (rule: BudgetRule, currentSpendUSD: number) => void;
}

export interface BudgetConfig {
  rules: BudgetRule[];
}

export interface BudgetStatus {
  feature: string;
  dailyLimitUSD: number;
  currentSpendUSD: number;
  exceeded: boolean;
  date: string;
}
