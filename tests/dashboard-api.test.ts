import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult, TaskRecord } from "../packages/agent-contracts/src/index.js";

describe("dashboard API", () => {
  const runtimeRoot = "runtime/test-dashboard-api";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("aggregates SLA and cost metrics for overview and tenant dashboards", async () => {
    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor: {
        async process(task: TaskRecord): Promise<RunResult> {
          if (task.envelope.tenantId === "acme") {
            return {
              taskId: task.taskId,
              runId: "run-acme",
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
                  summary: "acme done",
                },
              },
              artifacts: [],
              usage: {
                provider: "right-codes",
                model: "gpt-5-codex",
                estimatedCostUsd: 0.5,
                inputTokens: 100,
                outputTokens: 50,
              },
              diagnostics: {
                retries: 1,
                failoverAttempts: 1,
              },
              timestamps: {
                startedAt: "2026-04-14T01:00:00.000Z",
                finishedAt: "2026-04-14T01:00:05.000Z",
              },
            };
          }

          return {
            taskId: task.taskId,
            runId: "run-beta",
            specId: task.compiledSpec.specId,
            status: "timed_out",
            completion: {
              barrier: "settled-barrier",
              promptResolved: true,
              terminalEventSeen: true,
              noPendingBackgroundWork: true,
              finalizerPassed: false,
            },
            artifacts: [],
            usage: {
              provider: "openai-compatible",
              model: "gpt-5.4-mini",
              estimatedCostUsd: 0.2,
              inputTokens: 40,
              outputTokens: 20,
            },
            diagnostics: {
              retries: 0,
              failoverAttempts: 0,
            },
            error: {
              stage: "platform",
              code: "run.timeout",
              message: "timeout",
              retryable: false,
            },
            timestamps: {
              startedAt: "2026-04-14T01:10:00.000Z",
              finishedAt: "2026-04-14T01:10:02.000Z",
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    for (const payload of [
      {
        idempotencyKey: "dash-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 6000,
        input: {
          prompt: "任务一",
        },
        trace: {
          correlationId: "corr-dash-1",
        },
      },
      {
        idempotencyKey: "dash-2",
        tenantId: "beta",
        taskType: "requirement.analysis",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 1000,
        input: {
          prompt: "任务二",
          metadata: {
            approvalToken: "ticket-1",
          },
        },
        trace: {
          correlationId: "corr-dash-2",
        },
      },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/agent-tasks",
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    const overview = await app.inject({
      method: "GET",
      url: "/v1/dashboard/overview",
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      totals: {
        tasks: 2,
        costUsd: 0.7,
        averageDurationMs: 3500,
        slaBreaches: 1,
      },
      byStatus: {
        SUCCEEDED: 1,
        TIMED_OUT: 1,
      },
      byTenant: [
        {
          tenantId: "acme",
          tasks: 1,
          costUsd: 0.5,
        },
        {
          tenantId: "beta",
          tasks: 1,
          costUsd: 0.2,
        },
      ],
    });

    const tenantOverview = await app.inject({
      method: "GET",
      url: "/v1/dashboard/tenants/acme",
    });
    expect(tenantOverview.statusCode).toBe(200);
    expect(tenantOverview.json()).toMatchObject({
      tenantId: "acme",
      totals: {
        tasks: 1,
        costUsd: 0.5,
        averageDurationMs: 5000,
        slaBreaches: 0,
      },
      byStatus: {
        SUCCEEDED: 1,
      },
      byTaskType: {
        "code.review": 1,
      },
      providers: [
        {
          provider: "right-codes",
          model: "gpt-5-codex",
          tasks: 1,
          costUsd: 0.5,
        },
      ],
    });

    await app.close();
  });
});
