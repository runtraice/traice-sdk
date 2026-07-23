import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DurableCloudOutbox, type DurableQueuedCostEvent } from "../src/adapters/cloud-outbox";
import type { CostEvent } from "../src/types";

function queued(id: string): DurableQueuedCostEvent {
  const event: CostEvent = {
    id,
    timestamp: "2026-07-23T12:00:00.000Z",
    provider: "openai",
    model: "gpt-5-mini",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    inputCostUSD: 0.00001,
    outputCostUSD: 0.00001,
    totalCostUSD: 0.00002,
    latencyMs: 100,
  };
  return { event, enqueuedAt: Date.now() };
}

describe("DurableCloudOutbox", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "traice-sdk-outbox-"));
    filePath = path.join(directory, "events.ndjson");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("restores appended events after a new instance starts", async () => {
    const first = new DurableCloudOutbox(filePath);
    await first.append(queued("evt-1"));
    await first.append(queued("evt-2"));

    const restored = new DurableCloudOutbox(filePath).load();

    expect(restored.map(({ event }) => event.id)).toEqual(["evt-1", "evt-2"]);
  });

  it("atomically removes acknowledged events", async () => {
    const outbox = new DurableCloudOutbox(filePath);
    const remaining = queued("evt-2");
    await outbox.append(queued("evt-1"));
    await outbox.append(remaining);

    await outbox.replace([remaining]);

    expect(new DurableCloudOutbox(filePath).load().map(({ event }) => event.id)).toEqual(["evt-2"]);
  });

  it("ignores an incomplete trailing record after a process interruption", () => {
    fs.writeFileSync(filePath, `${JSON.stringify(queued("evt-1"))}\n{"event":`);

    expect(new DurableCloudOutbox(filePath).load().map(({ event }) => event.id)).toEqual(["evt-1"]);
  });
});
