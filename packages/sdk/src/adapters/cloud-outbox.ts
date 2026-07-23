import * as fs from "fs";
import * as path from "path";
import type { CostEvent } from "../types";

export type DurableQueuedCostEvent = {
  event: CostEvent;
  enqueuedAt: number;
};

/**
 * Small process-local durable queue for cloud delivery.
 *
 * Mutations are serialized so appends that overlap a delivery acknowledgement
 * cannot restore an already-delivered event or discard a newly-enqueued event.
 */
export class DurableCloudOutbox {
  private mutation = Promise.resolve();

  constructor(private readonly filePath: string) {}

  load(): DurableQueuedCostEvent[] {
    try {
      const body = fs.readFileSync(this.filePath, "utf8");
      return body
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line) as Partial<DurableQueuedCostEvent>;
            if (!value.event || typeof value.enqueuedAt !== "number") return [];
            return [value as DurableQueuedCostEvent];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  append(item: DurableQueuedCostEvent): Promise<void> {
    return this.enqueue(async () => {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(this.filePath, `${JSON.stringify(item)}\n`, { encoding: "utf8", mode: 0o600 });
    });
  }

  replace(items: readonly DurableQueuedCostEvent[]): Promise<void> {
    return this.enqueue(() => this.writeSnapshot(items));
  }

  replaceSync(items: readonly DurableQueuedCostEvent[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryPath, serialize(items), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.catch(() => undefined);
    return next;
  }

  private async writeSnapshot(items: readonly DurableQueuedCostEvent[]): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    await fs.promises.writeFile(temporaryPath, serialize(items), { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporaryPath, this.filePath);
  }
}

function serialize(items: readonly DurableQueuedCostEvent[]): string {
  return items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}
