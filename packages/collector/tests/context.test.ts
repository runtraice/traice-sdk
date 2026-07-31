import type { InternalUsageEvent } from "@traice/protocol";
import { describe, expect, it } from "vitest";
import { buildDefaultConfig } from "../src/config";
import {
  clearCollectorDestinationContext,
  COLLECTOR_CONTEXT_LIMITS,
  collectorDestinationContextSummary,
  eventForCollectorDestination,
  parseContextLabels,
  updateCollectorDestinationContext,
} from "../src/context";
import { configForDestination, upsertCollectorDestination } from "../src/destinations";
import type { CollectorConfig } from "../src/types";

const event: InternalUsageEvent = {
  sourceKey: "codex-local",
  sourceKind: "codex_otel",
  tool: "codex",
  category: "coding_agent",
  sourceEventId: "event-1",
  occurredAt: "2026-07-30T12:00:00.000Z",
  employeeEmail: "personal@example.com",
  teamName: "Engineering",
  totalTokens: 100,
  metadata: { eventName: "response.completed" },
};

function config(): CollectorConfig {
  return {
    ...buildDefaultConfig(),
    identity: {
      employeeEmail: "personal@example.com",
      employeeName: "Example User",
      teamName: "Engineering",
      sourcePrincipal: "host:user",
    },
    destinations: {
      personal: { serverUrl: "https://example.test" },
      work: { serverUrl: "https://example.test" },
    },
  };
}

describe("collector destination context", () => {
  it("isolates identity and manual context by destination", () => {
    const configured = updateCollectorDestinationContext(config(), "work", {
      identity: {
        employeeEmail: "engineer@example.com",
        teamName: null,
        sourcePrincipal: "host:user:work",
      },
      context: {
        role: "Staff Engineer",
        department: "Product Engineering",
        description: "Classify collector work",
        repository: "example/widgets",
        labels: { workType: "product", priority: 1 },
      },
    });

    expect(eventForCollectorDestination(configured, "work", event)).toMatchObject({
      employeeEmail: "engineer@example.com",
      sourcePrincipal: "host:user:work",
      metadata: {
        eventName: "response.completed",
        role: "Staff Engineer",
        department: "Product Engineering",
        task: {
          description: "Classify collector work",
          repository: "example/widgets",
          labels: { workType: "product", priority: 1 },
        },
      },
    });
    expect(eventForCollectorDestination(configured, "work", event)).not.toHaveProperty("teamName");
    expect(eventForCollectorDestination(configured, "personal", event)).toEqual(event);
  });

  it("merges destination identity for backfill and destination-scoped callers", () => {
    const configured = updateCollectorDestinationContext(config(), "work", {
      identity: { employeeEmail: "engineer@example.com", teamName: null },
      context: {
        role: "Staff Engineer",
        department: "Product Engineering",
        description: "Current task only",
        repository: "example/widgets",
      },
    });

    expect(configForDestination(configured, "work").identity).toEqual({
      employeeEmail: "engineer@example.com",
      employeeName: "Example User",
      sourcePrincipal: "host:user",
    });
    expect(eventForCollectorDestination(configured, "work", event, { includeTaskContext: false }).metadata).toEqual({
      eventName: "response.completed",
      role: "Staff Engineer",
      department: "Product Engineering",
    });
  });

  it("bounds and redacts custom JSON labels", () => {
    expect(parseContextLabels('{"category":"feature","apiKey":"sk-abcdefghijklmnop"}')).toEqual({
      category: "feature",
      apiKey: "[redacted]",
    });
    expect(() => parseContextLabels("[]")).toThrow("JSON object");
    expect(() =>
      parseContextLabels(JSON.stringify({ value: "x".repeat(COLLECTOR_CONTEXT_LIMITS.labelStringChars + 1) })),
    ).toThrow(`${COLLECTOR_CONTEXT_LIMITS.labelStringChars} characters`);
  });

  it("clears task context without removing identity unless requested", () => {
    const configured = updateCollectorDestinationContext(config(), "work", {
      identity: { employeeEmail: "engineer@example.com" },
      context: { role: "Staff Engineer" },
    });
    const contextCleared = clearCollectorDestinationContext(configured, "work");

    expect(collectorDestinationContextSummary(contextCleared, "work")).toMatchObject({
      identity: { employeeEmail: "engineer@example.com" },
      context: {},
    });
    expect(
      collectorDestinationContextSummary(clearCollectorDestinationContext(contextCleared, "work", true), "work"),
    ).toMatchObject({
      identity: { employeeEmail: "personal@example.com" },
      context: {},
    });
  });

  it("preserves context when authorization or install refreshes the destination", () => {
    const configured = updateCollectorDestinationContext(config(), "work", {
      identity: { employeeEmail: "engineer@example.com" },
      context: { role: "Staff Engineer", department: "Product Engineering" },
    });
    const refreshed = upsertCollectorDestination(configured, "work", {
      serverUrl: "https://new.example.test",
      credential: { backend: "protected-file", path: "/tmp/credential.json" },
    });

    expect(refreshed.destinations.work).toMatchObject({
      serverUrl: "https://new.example.test",
      identity: { employeeEmail: "engineer@example.com" },
      context: { role: "Staff Engineer", department: "Product Engineering" },
    });
  });
});
