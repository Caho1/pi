import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso, randomId, readJsonFile, writeJsonFile } from "../../../packages/agent-platform-shared/src/index.js";

export interface TaskQueue {
  enqueue(taskId: string): Promise<void>;
}

interface QueueItem {
  queueId: string;
  taskId: string;
  enqueuedAt: string;
  attempts: number;
  leaseExpiresAt?: string;
  lastError?: string;
}

export class InlineTaskQueue implements TaskQueue {
  private readonly items: string[] = [];
  private running = false;

  constructor(private readonly onProcess: (taskId: string) => Promise<void>) {}

  enqueue(taskId: string): Promise<void> {
    this.items.push(taskId);
    return this.run();
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.items.length > 0) {
        const taskId = this.items.shift();
        if (!taskId) {
          continue;
        }
        await this.onProcess(taskId);
      }
    } finally {
      this.running = false;
    }
  }
}

export class FileSystemTaskQueue implements TaskQueue {
  private readonly queueRoot: string;
  private readonly pendingDir: string;
  private readonly leasedDir: string;
  private readonly failedDir: string;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(
    runtimeRoot: string,
    options?: {
      leaseMs?: number;
      maxAttempts?: number;
    },
  ) {
    this.queueRoot = path.join(runtimeRoot, "data", "queue");
    this.pendingDir = path.join(this.queueRoot, "pending");
    this.leasedDir = path.join(this.queueRoot, "leased");
    this.failedDir = path.join(this.queueRoot, "failed");
    this.leaseMs = options?.leaseMs ?? 30_000;
    this.maxAttempts = options?.maxAttempts ?? 1;
  }

  async initialize(): Promise<void> {
    await Promise.all([this.pendingDir, this.leasedDir, this.failedDir].map((dir) => ensureDir(dir)));
  }

  async enqueue(taskId: string): Promise<void> {
    await this.initialize();

    const existingPending = await this.readItemIfExists(path.join(this.pendingDir, `${taskId}.json`));
    const existingLeased = await this.readItemIfExists(path.join(this.leasedDir, `${taskId}.json`));
    if (existingPending || existingLeased) {
      return;
    }

    const item: QueueItem = {
      queueId: randomId("queue"),
      taskId,
      enqueuedAt: nowIso(),
      attempts: 0,
    };
    await writeJsonFile(path.join(this.pendingDir, `${taskId}.json`), item);
  }

  async claimNext(): Promise<QueueItem | undefined> {
    await this.initialize();
    await this.recoverExpiredLeases();

    const entries = (await fs.readdir(this.pendingDir)).filter((entry) => entry.endsWith(".json")).sort();
    for (const entry of entries) {
      const pendingPath = path.join(this.pendingDir, entry);
      const leasedPath = path.join(this.leasedDir, entry);
      try {
        await fs.rename(pendingPath, leasedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const item = await readJsonFile<QueueItem>(leasedPath);
      const leasedItem: QueueItem = {
        ...item,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
      };
      await writeJsonFile(leasedPath, leasedItem);
      return leasedItem;
    }

    return undefined;
  }

  async ack(taskId: string): Promise<void> {
    await fs.rm(path.join(this.leasedDir, `${taskId}.json`), { force: true });
  }

  async fail(item: QueueItem, error: unknown): Promise<void> {
    const leasedPath = path.join(this.leasedDir, `${item.taskId}.json`);
    const next: QueueItem = {
      ...item,
      attempts: item.attempts + 1,
      leaseExpiresAt: undefined,
      lastError: error instanceof Error ? error.message : String(error),
    };

    if (next.attempts >= this.maxAttempts) {
      await writeJsonFile(path.join(this.failedDir, `${item.taskId}.json`), next);
      await fs.rm(leasedPath, { force: true });
      return;
    }

    await writeJsonFile(path.join(this.pendingDir, `${item.taskId}.json`), next);
    await fs.rm(leasedPath, { force: true });
  }

  private async recoverExpiredLeases(): Promise<void> {
    const now = Date.now();
    const entries = (await fs.readdir(this.leasedDir)).filter((entry) => entry.endsWith(".json"));

    for (const entry of entries) {
      const leasedPath = path.join(this.leasedDir, entry);
      const item = await this.readItemIfExists(leasedPath);
      if (!item?.leaseExpiresAt) {
        continue;
      }

      if (new Date(item.leaseExpiresAt).getTime() > now) {
        continue;
      }

      await writeJsonFile(path.join(this.pendingDir, entry), {
        ...item,
        leaseExpiresAt: undefined,
      });
      await fs.rm(leasedPath, { force: true });
    }
  }

  private async readItemIfExists(filePath: string): Promise<QueueItem | undefined> {
    try {
      return await readJsonFile<QueueItem>(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}

export class FileSystemTaskWorker {
  constructor(
    private readonly queue: FileSystemTaskQueue,
    private readonly onProcess: (taskId: string) => Promise<void>,
  ) {}

  async runOnce(): Promise<boolean> {
    const item = await this.queue.claimNext();
    if (!item) {
      return false;
    }

    try {
      await this.onProcess(item.taskId);
      await this.queue.ack(item.taskId);
    } catch (error) {
      await this.queue.fail(item, error);
    }

    return true;
  }

  async runUntilIdle(options?: {
    maxIterations?: number;
  }): Promise<void> {
    const maxIterations = options?.maxIterations ?? 100;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const processed = await this.runOnce();
      if (!processed) {
        return;
      }
    }
  }
}
