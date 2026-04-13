import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  RpcTaskProcessorClient,
  RpcTaskProcessorPool,
} from "../apps/agent-control-plane/src/rpc-task-processor.js";
import type { TaskRecord } from "../packages/agent-contracts/src/index.js";

describe("RPC task processor", () => {
  const disposables: Array<{ dispose: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((item) => item.dispose()));
  });

  test("dispatches tasks across RPC workers with round-robin balancing", async () => {
    const workerScript = path.resolve("tests/fixtures/mock-rpc-worker.mjs");

    const clientA = new RpcTaskProcessorClient({
      command: process.execPath,
      args: [workerScript],
      env: {
        ...process.env,
        MOCK_WORKER_ID: "worker-a",
      },
    });
    const clientB = new RpcTaskProcessorClient({
      command: process.execPath,
      args: [workerScript],
      env: {
        ...process.env,
        MOCK_WORKER_ID: "worker-b",
      },
    });
    disposables.push(clientA, clientB);

    const pool = new RpcTaskProcessorPool([clientA, clientB]);

    const first = await pool.process(createTaskRecord("task-rpc-1"));
    const second = await pool.process(createTaskRecord("task-rpc-2"));

    expect(first.runId).toContain("worker-a");
    expect(second.runId).toContain("worker-b");
    await expect(pool.cancel("task-rpc-2")).resolves.toBe(true);
  });
});

function createTaskRecord(taskId: string): TaskRecord {
  return {
    taskId,
    idempotencyFingerprint: `fp-${taskId}`,
    envelope: {
      taskId,
      runRequestId: `req-${taskId}`,
      idempotencyKey: `idem-${taskId}`,
      tenantId: "acme",
      taskType: "code.review",
      agentType: "reviewer",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: {
        prompt: `process ${taskId}`,
      },
      trace: {
        correlationId: `corr-${taskId}`,
      },
    },
    compiledSpec: {
      specId: `sha256:${taskId}`,
      agentType: "reviewer",
      version: "1.0.0",
      displayName: "Reviewer",
      sdkCompatibility: {
        packageName: "@mariozechner/pi-coding-agent",
        exactVersion: "0.66.1",
        adapterVersion: "1.0.0",
      },
      prompts: {
        preservePiDefaultSystemPrompt: true,
        appendSystemPrompts: [],
        agentsFiles: [],
      },
      resources: {
        skillRefs: [],
        extensionRefs: [],
        extensionDigests: {},
        promptTemplateRefs: [],
      },
      toolPolicy: {
        mode: "allowlist",
        tools: ["read"],
      },
      modelPolicy: {
        providerAllowlist: ["right-codes"],
      },
      workspacePolicy: {
        mode: "readonly",
        retainOnFailure: true,
        network: "disabled",
        maxDiskMb: 32,
        ttlMinutes: 1,
      },
      compactionPolicy: {
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
        settledTimeoutMs: 1000,
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
      buildInfo: {
        builtAt: "2026-04-14T02:30:00.000Z",
        builtBy: "test",
        sourceDigest: "sha256:test",
      },
    },
    status: "ROUTED",
    artifacts: [],
    createdAt: "2026-04-14T02:30:00.000Z",
    updatedAt: "2026-04-14T02:30:00.000Z",
  };
}
