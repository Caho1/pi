import fs from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";

describe("task dead-letter queue", () => {
  test("writes failed background task processing to DLQ", async () => {
    const runtimeRoot = "runtime/test-task-dlq";
    await fs.rm(runtimeRoot, { recursive: true, force: true });

    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor: {
        async process() {
          throw new Error("worker exploded");
        },
        async cancel() {
          return false;
        },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "dlq-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 1000,
        input: { prompt: "trigger failure" },
        trace: { correlationId: "corr-dlq" },
      },
    });

    expect(response.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const dlq = await fs.readFile(`${runtimeRoot}/data/task-dlq.jsonl`, "utf8");
    expect(dlq).toContain("worker exploded");

    const taskId = response.json().taskId as string;
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/agent-tasks/${taskId}`,
    });
    expect(fetched.json().status).toBe("FAILED");

    await app.close();
  });
});
