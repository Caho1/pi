import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import { CallbackDispatcher } from "../apps/agent-control-plane/src/callback-dispatcher.js";
import { TaskDeadLetterStore } from "../apps/agent-control-plane/src/task-dead-letter.js";
import {
  FileSystemTaskQueue,
  FileSystemTaskWorker,
} from "../apps/agent-control-plane/src/task-queue.js";
import { TaskExecutionCoordinator } from "../apps/agent-control-plane/src/task-runner.js";
import type { RunResult, TaskRecord } from "../packages/agent-contracts/src/index.js";
import { JsonFileTaskRepository } from "../packages/agent-platform-shared/src/index.js";

describe("filesystem task queue", () => {
  const runtimeRoot = "runtime/test-filesystem-queue";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("recovers an expired lease after a worker restart", async () => {
    const queue = new FileSystemTaskQueue(runtimeRoot, {
      leaseMs: 20,
    });
    await queue.initialize();
    await queue.enqueue("task-lease-recovery");

    const claimed = await queue.claimNext();
    expect(claimed?.taskId).toBe("task-lease-recovery");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const restartedQueue = new FileSystemTaskQueue(runtimeRoot, {
      leaseMs: 20,
    });
    await restartedQueue.initialize();
    const reclaimed = await restartedQueue.claimNext();

    expect(reclaimed?.taskId).toBe("task-lease-recovery");
  });

  test("lets the control plane enqueue while an external worker processes the task", async () => {
    const queue = new FileSystemTaskQueue(runtimeRoot, {
      leaseMs: 1000,
    });
    await queue.initialize();

    const repository = new JsonFileTaskRepository(runtimeRoot);
    await repository.initialize();

    const processor = {
      async process(task: TaskRecord) {
        return {
          taskId: task.taskId,
          runId: "run-filesystem-queue",
          specId: task.compiledSpec.specId,
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
            structured: {
              summary: "processed by external worker",
            },
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
    };

    const worker = new FileSystemTaskWorker(
      queue,
      async (taskId) => {
        const coordinator = new TaskExecutionCoordinator({
          repository,
          processor,
          callbackDispatcher: new CallbackDispatcher({
            runtimeRoot,
            retryPolicy: {
              maxAttempts: 1,
              backoffBaseMs: 1,
              backoffMaxMs: 1,
            },
          }),
          taskDeadLetterStore: new TaskDeadLetterStore(runtimeRoot),
        });
        await coordinator.process(taskId);
      },
    );

    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor,
      taskQueue: queue,
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "queue-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 1000,
        input: { prompt: "Review this through the queue" },
        trace: { correlationId: "corr-queue" },
      },
    });

    expect(created.statusCode).toBe(202);
    expect(created.json().status).toBe("ROUTED");

    await worker.runUntilIdle();

    const taskId = created.json().taskId as string;
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/agent-tasks/${taskId}`,
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().status).toBe("SUCCEEDED");

    await app.close();
  });
});
