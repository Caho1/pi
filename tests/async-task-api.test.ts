import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult } from "../packages/agent-contracts/src/index.js";

describe("async task execution", () => {
  const runtimeRoot = "runtime/test-async-api";

  afterEach(async () => {
    delete process.env.PLATFORM_TASK_QUEUE_MAX_CONCURRENT;
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

  test("processes multiple async tasks concurrently when inline queue parallelism is enabled", async () => {
    process.env.PLATFORM_TASK_QUEUE_MAX_CONCURRENT = "2";

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedCount = 0;
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    let activeCount = 0;
    let maxActiveCount = 0;

    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor: {
        async process(task) {
          activeCount += 1;
          maxActiveCount = Math.max(maxActiveCount, activeCount);
          startedCount += 1;
          if (startedCount === 2) {
            resolveBothStarted();
          }

          await gate;
          activeCount -= 1;
          return {
            taskId: task.taskId,
            runId: `run-${task.taskId}`,
            specId: "sha256:async-parallel",
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

    const firstResponsePromise = app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "async-parallel-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 2_000,
        input: { prompt: "parallel task 1" },
        trace: { correlationId: "corr-async-parallel-1" },
      },
    });
    const secondResponsePromise = app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "async-parallel-2",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 2_000,
        input: { prompt: "parallel task 2" },
        trace: { correlationId: "corr-async-parallel-2" },
      },
    });

    const [firstResponse, secondResponse] = await Promise.all([firstResponsePromise, secondResponsePromise]);
    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);

    await bothStarted;
    expect(maxActiveCount).toBe(2);

    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    for (const response of [firstResponse, secondResponse]) {
      const taskId = response.json().taskId as string;
      const fetched = await app.inject({
        method: "GET",
        url: `/v1/agent-tasks/${taskId}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().status).toBe("SUCCEEDED");
    }

    await app.close();
  });
});
