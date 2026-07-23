import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InternalUsageEvent } from "@traice/protocol";

export type CollectorOutboxStats = {
  queued: number;
  oldestQueuedAt: string | null;
  enqueued: number;
  delivered: number;
  deduplicated: number;
  overflowDropped: number;
  failedBatches: number;
  retries: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
};

export class CollectorOutbox {
  private events: InternalUsageEvent[] = [];
  private ids = new Set<string>();
  private loaded = false;
  private mutations: Promise<void> = Promise.resolve();
  private counters = {
    enqueued: 0,
    delivered: 0,
    deduplicated: 0,
    overflowDropped: 0,
    failedBatches: 0,
    retries: 0,
    lastSuccessAt: null as string | null,
    lastErrorAt: null as string | null,
  };

  constructor(
    readonly path: string,
    readonly maxEvents = 10_000,
  ) {
    if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer");
  }

  async initialize(): Promise<void> {
    await this.mutate(async () => {
      if (this.loaded) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      let text = "";
      try {
        text = await readFile(this.path, "utf8");
        await chmod(this.path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as InternalUsageEvent;
          if (!event.sourceEventId || this.ids.has(event.sourceEventId)) continue;
          this.events.push(event);
          this.ids.add(event.sourceEventId);
        } catch {
          // Preserve service availability if one interrupted write left a partial line.
        }
      }
      if (this.events.length > this.maxEvents) {
        const dropped = this.events.splice(0, this.events.length - this.maxEvents);
        for (const event of dropped) this.ids.delete(event.sourceEventId);
        this.counters.overflowDropped += dropped.length;
        await this.rewrite();
      }
      this.loaded = true;
    });
  }

  async enqueue(incoming: InternalUsageEvent[]): Promise<{ queued: number; deduplicated: number; dropped: number }> {
    let deduplicated = 0;
    let dropped = 0;
    await this.mutate(async () => {
      this.assertInitialized();
      const accepted: InternalUsageEvent[] = [];
      for (const event of incoming) {
        if (this.ids.has(event.sourceEventId)) {
          deduplicated++;
          continue;
        }
        accepted.push(event);
        this.ids.add(event.sourceEventId);
      }
      this.events.push(...accepted);
      this.counters.enqueued += accepted.length;
      this.counters.deduplicated += deduplicated;

      if (this.events.length > this.maxEvents) {
        const overflow = this.events.splice(0, this.events.length - this.maxEvents);
        for (const event of overflow) this.ids.delete(event.sourceEventId);
        dropped = overflow.length;
        this.counters.overflowDropped += dropped;
        await this.rewrite();
      } else if (accepted.length > 0) {
        await appendFile(this.path, accepted.map((event) => JSON.stringify(event)).join("\n") + "\n", {
          encoding: "utf8",
          mode: 0o600,
        });
      }
    });
    return { queued: incoming.length - deduplicated - dropped, deduplicated, dropped };
  }

  async peek(limit: number): Promise<InternalUsageEvent[]> {
    await this.mutations;
    this.assertInitialized();
    return this.events.slice(0, Math.max(1, Math.floor(limit)));
  }

  async acknowledge(sourceEventIds: readonly string[]): Promise<void> {
    const acknowledged = new Set(sourceEventIds);
    if (acknowledged.size === 0) return;
    await this.mutate(async () => {
      this.assertInitialized();
      const before = this.events.length;
      this.events = this.events.filter((event) => !acknowledged.has(event.sourceEventId));
      for (const id of acknowledged) this.ids.delete(id);
      const removed = before - this.events.length;
      if (removed > 0) {
        this.counters.delivered += removed;
        this.counters.lastSuccessAt = new Date().toISOString();
        await this.rewrite();
      }
    });
  }

  recordFailure(retries = 0): void {
    this.counters.failedBatches++;
    this.counters.retries += Math.max(0, Math.floor(retries));
    this.counters.lastErrorAt = new Date().toISOString();
  }

  stats(): CollectorOutboxStats {
    return {
      queued: this.events.length,
      oldestQueuedAt: this.events[0]?.occurredAt ?? null,
      ...this.counters,
    };
  }

  private mutate(operation: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => {});
    return next;
  }

  private assertInitialized(): void {
    if (!this.loaded) throw new Error("Collector outbox is not initialized");
  }

  private async rewrite(): Promise<void> {
    const temporary = `${this.path}.tmp`;
    const body = this.events.map((event) => JSON.stringify(event)).join("\n");
    await writeFile(temporary, body ? body + "\n" : "", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
