import type { InternalUsageEvent } from "@traice/protocol";
import type { OtlpNormalizeOptions } from "../types";
import { extractLogRecords, extractMetricPoints, otelMetricPointToUsageEvent, otelRecordToUsageEvent } from "../otel";

export function normalizeClaudeCodeOtlpLogs(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[] {
  return extractLogRecords(payload)
    .map((record) =>
      otelRecordToUsageEvent(record, options.source, options.identity, {
        receivedAt: options.receivedAt,
        agent: "claude-code",
      }),
    )
    .filter((event): event is InternalUsageEvent => event !== null);
}

export function normalizeClaudeCodeOtlpMetrics(payload: unknown, options: OtlpNormalizeOptions): InternalUsageEvent[] {
  return extractMetricPoints(payload)
    .map((point) =>
      otelMetricPointToUsageEvent(point, options.source, options.identity, {
        receivedAt: options.receivedAt,
        agent: "claude-code",
      }),
    )
    .filter((event): event is InternalUsageEvent => event !== null);
}
