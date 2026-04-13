import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildControlPlaneApp } from "../apps/agent-control-plane/src/server.js";
import type { RunResult, TaskRecord } from "../packages/agent-contracts/src/index.js";

describe("spec version management", () => {
  const runtimeRoot = "runtime/test-spec-version-management";
  const specsRoot = path.join(runtimeRoot, "agent-specs");

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("lists versions and supports rollback of the active spec version", async () => {
    await writeAgentSpec(path.join(specsRoot, "reviewer-v1"), "reviewer", "1.0.0", "Reviewer v1");
    await writeAgentSpec(path.join(specsRoot, "reviewer-v2"), "reviewer", "2.0.0", "Reviewer v2");

    const seenVersions: string[] = [];
    const app = await buildControlPlaneApp({
      runtimeRoot,
      registryRoot: specsRoot,
      processor: {
        async process(task: TaskRecord): Promise<RunResult> {
          seenVersions.push(task.compiledSpec.version);
          return {
            taskId: task.taskId,
            runId: `run-${task.compiledSpec.version}`,
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
                version: task.compiledSpec.version,
              },
            },
            artifacts: [],
            timestamps: {
              startedAt: "2026-04-14T02:00:00.000Z",
              finishedAt: "2026-04-14T02:00:01.000Z",
            },
          };
        },
        async cancel() {
          return false;
        },
      },
    });

    const versionsResponse = await app.inject({
      method: "GET",
      url: "/v1/agent-specs/reviewer/versions",
    });
    expect(versionsResponse.statusCode).toBe(200);
    expect(versionsResponse.json()).toMatchObject({
      agentType: "reviewer",
      activeVersion: "2.0.0",
      versions: ["1.0.0", "2.0.0"],
    });

    const beforeRollback = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "spec-version-1",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 1000,
        input: {
          prompt: "使用当前激活版本",
        },
        trace: {
          correlationId: "corr-spec-version-1",
        },
      },
    });
    expect(beforeRollback.statusCode).toBe(200);
    expect(beforeRollback.json().runResult.result.structured.version).toBe("2.0.0");

    const rollback = await app.inject({
      method: "POST",
      url: "/v1/agent-specs/reviewer/rollback",
      payload: {
        version: "1.0.0",
      },
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({
      agentType: "reviewer",
      activeVersion: "1.0.0",
      previousVersion: "2.0.0",
    });

    const afterRollback = await app.inject({
      method: "POST",
      url: "/v1/agent-tasks",
      payload: {
        idempotencyKey: "spec-version-2",
        tenantId: "acme",
        taskType: "code.review",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: 1000,
        input: {
          prompt: "使用回滚后的版本",
        },
        trace: {
          correlationId: "corr-spec-version-2",
        },
      },
    });
    expect(afterRollback.statusCode).toBe(200);
    expect(afterRollback.json().runResult.result.structured.version).toBe("1.0.0");
    expect(seenVersions).toEqual(["2.0.0", "1.0.0"]);

    await app.close();
  });
});

async function writeAgentSpec(
  agentDir: string,
  agentType: string,
  version: string,
  displayName: string,
): Promise<void> {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "policy.json"),
    JSON.stringify(
      {
        agentType,
        version,
        displayName,
        skillRefs: [],
        extensionRefs: [],
        promptTemplates: [],
        defaultModelPolicy: {
          providerAllowlist: ["right-codes"],
          modelAllowlist: ["gpt-5-codex"],
          failoverOrder: [{ provider: "right-codes", model: "gpt-5-codex" }],
        },
        defaultToolPolicy: {
          mode: "allowlist",
          tools: ["read"],
        },
        defaultWorkspacePolicy: {
          mode: "readonly",
          retainOnFailure: true,
          network: "disabled",
          maxDiskMb: 32,
          ttlMinutes: 1,
        },
        defaultCompactionPolicy: {
          mode: "default",
          emitCompactionDiagnostics: true,
        },
        outputContract: {
          mode: "tool-submission",
          requireSubmitResultTool: false,
          textFallbackAllowed: true,
        },
        sessionReusePolicy: {
          mode: "none",
          persistent: false,
        },
        subagentPolicy: {
          enabled: false,
          maxDepth: 1,
          maxBreadth: 1,
          maxParallel: 1,
          inheritWorkspace: true,
          inheritToolPolicy: true,
          inheritModelPolicy: true,
        },
        completionPolicy: {
          requirePromptResolved: true,
          requireTerminalEvent: true,
          requireNoPendingWork: true,
          requireSubmitResult: false,
          settledTimeoutMs: 100,
        },
        extensionGovernance: {
          allowedExtensionRefs: [],
          allowRuntimeInstall: false,
          allowWorkspaceDiscovery: false,
          hashPinned: true,
        },
        costPolicy: {},
        retryPolicy: {
          maxRetries: 0,
          retryableErrors: [],
          backoffBaseMs: 1,
          backoffMaxMs: 1,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}
