import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult } from "../packages/agent-contracts/src/index.js";

describe("async task execution", () => {
  const runtimeRoot = "runtime/test-async-api";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("returns immediately for async tasks and completes in background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor: {
        async process(task) {
          await gate;
          return {
            taskId: task.taskId,
            runId: "run-async",
            specId: "sha256:async",
            status: "succeeded",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: true,
            },
            result: {
              submissionMode: "submit_result",
              structured: { summary: "done" },
            },
            artifacts: [],
            timestamps: {
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            },
          } satisfies RunResult;
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
        idempotencyKey: "async-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 1000,
        input: { prompt: "Review async change" },
        trace: { correlationId: "corr-async" },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("ROUTED");

    const taskId = response.json().taskId as string;
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/agent-tasks/${taskId}`,
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe("SUCCEEDED");
    await app.close();
  });
});
