import { CostAdapter } from "../types";
import { ConsoleAdapter } from "./console";
import { LocalAdapter } from "./local";
import { CloudAdapter } from "./cloud";

export { ConsoleAdapter } from "./console";
export { LocalAdapter } from "./local";
export { WebhookAdapter } from "./webhook";
export { OTelAdapter } from "./otel";
export { CloudAdapter } from "./cloud";
export { TraiceEnforcementError } from "./cloud";
export type {
  BlockingRuleAction,
  BudgetAdvice,
  BudgetPolicyContext,
  BudgetPolicyMatch,
  CloudAdapterConfig,
  CloudDeliveryStats,
  CloudDeliverySummary,
  EnforcementEvidence,
  EnforcementErrorContext,
  EnforcementStats,
  ExactCacheContext,
  ExactCacheRequest,
  ExactCacheStats,
  ModelRuleAction,
  RequestEnforcementContext,
  SemanticCacheConfig,
  SemanticCacheStats,
} from "./cloud";

export interface AdapterResolveOptions {
  localPath?: string;
  cloudApiKey?: string;
  cloudEndpoint?: string;
  cloudMaxQueueSize?: number;
  cloudCaptureContent?: boolean;
  cloudDurableQueuePath?: string;
}

export function createAdapter(name: string, options: AdapterResolveOptions = {}): CostAdapter {
  switch (name) {
    case "console":
      return new ConsoleAdapter();
    case "local":
      return new LocalAdapter(options.localPath ?? "./.traice-costs/events.ndjson");
    case "cloud":
      if (!options.cloudApiKey) {
        throw new Error(
          "CloudAdapter requires an API key. Set cloudApiKey in configure() or get one at https://runtraice.com",
        );
      }
      return new CloudAdapter({
        apiKey: options.cloudApiKey,
        endpoint: options.cloudEndpoint,
        maxQueueSize: options.cloudMaxQueueSize,
        captureContent: options.cloudCaptureContent,
        durableQueuePath: options.cloudDurableQueuePath,
      });
    default:
      throw new Error(
        `Unknown adapter: ${name}. Available: console, local, cloud. For webhook/otel, pass an instance.`,
      );
  }
}

export function resolveAdapters(
  adapters: Array<string | CostAdapter>,
  options: AdapterResolveOptions = {},
): CostAdapter[] {
  return adapters.map((adapter) => {
    if (typeof adapter === "string") {
      return createAdapter(adapter, options);
    }
    return adapter;
  });
}
