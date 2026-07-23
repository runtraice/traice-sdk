import type { InternalUsageEvent } from "@traice/protocol";
import type { OtlpNormalizeOptions } from "../types";
import { extractLogRecords, otelRecordToUsageEvent } from "../otel";

export function normalizeCodexOtlpLogs(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[] {
  return extractLogRecords(payload)
    .map((record) =>
      otelRecordToUsageEvent(record, options.source, options.identity, {
        receivedAt: options.receivedAt,
        agent: "codex",
        includePrompts: options.includePrompts,
      }),
    )
    .filter((event): event is InternalUsageEvent => event !== null);
}
