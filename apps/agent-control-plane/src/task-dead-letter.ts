import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso } from "../../../packages/agent-platform-shared/src/index.js";

export class TaskDeadLetterStore {
  private readonly filePath: string;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, "data", "task-dlq.jsonl");
  }

  async append(entry: {
    taskId: string;
    stage: string;
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    await fs.appendFile(
      this.filePath,
      `${JSON.stringify({
        ...entry,
        timestamp: nowIso(),
      })}\n`,
      "utf8",
    );
  }
}
