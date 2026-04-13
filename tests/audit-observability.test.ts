import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult } from "../packages/agent-contracts/src/index.js";

describe("audit log and metrics", () => {
  afterEach(async () => {
    await fs.rm("runtime/test-audit-observability", { recursive: true, force: true });
  });

  test("persists audit entries and exposes observability counters after task completion", async () => {
    const cannedResult: RunResult = {
      taskId: "task-audit",
      runId: "run-audit",
      specId: "sha256:audit",
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
          summary: "审计与指标验证成功",
        },
      },
      artifacts: [
        {
          artifactId: "artifact-1",
          kind: "report",
          uri: "file:///tmp/report.json",
        },
      ],
      usage: {
        provider: "openai-compatible",
        model: "gpt-5.4-mini",
        inputTokens: 128,
        outputTokens: 64,
        estimatedCostUsd: 0.42,
        subagentCount: 2,
      },
      compaction: {
        happened: true,
        count: 1,
        policyMode: "safeguard",
      },
      diagnostics: {
        retries: 3,
        failoverAttempts: 1,
      },
      timestamps: {
        startedAt: "2026-04-14T10:00:00.000Z",
        finishedAt: "2026-04-14T10:00:05.000Z",
      },
    };

    const runtimeRoot = "runtime/test-audit-observability";
    const app = await buildControlPlaneApp({
      runtimeRoot,
      processor: {
        async process(task) {
          return {
            ...cannedResult,
            taskId: task.taskId,
          };
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
        idempotencyKey: "audit-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 1000,
        input: {
          prompt: "请输出结构化审计结果",
        },
        trace: {
          correlationId: "corr-audit-1",
        },
      },
    });

    expect(response.statusCode).toBe(200);

    const auditPath = path.join(runtimeRoot, "audit", "audit.jsonl");
    const auditContent = await fs.readFile(auditPath, "utf8");
    const [entry] = auditContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(entry).toMatchObject({
      taskId: response.json().taskId,
      runId: "run-audit",
      specId: expect.any(String),
      tenantId: "acme",
      regressionSuiteVersion: "2026-04-14",
      provider: "openai-compatible",
      model: "gpt-5.4-mini",
      workspaceMode: "readonly",
      compactionHappened: true,
      failoverAttempts: 1,
      submitResultUsed: true,
      artifactsCount: 1,
      finalStatus: "SUCCEEDED",
    });

    const metrics = await app.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json()).toMatchObject({
      task_run_total: 1,
      task_run_succeeded_total: 1,
      task_run_compaction_total: 1,
      task_run_failover_total: 1,
      task_run_retry_total: 3,
      task_run_tokens_input_total: 128,
      task_run_tokens_output_total: 64,
      task_run_cost_usd_total: 0.42,
      subagent_spawn_total: 2,
    });
    expect(metrics.json().task_run_duration_ms_total).toBe(5000);

    await app.close();
  });
});
