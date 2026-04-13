import fs from "node:fs/promises";

import { afterEach, describe, expect, test } from "vitest";

import {
  DefaultEventTranslator,
  DefaultPiExecutor,
  DefaultPiResourceAssembler,
  FileSystemArtifactStore,
  FileSystemTraceStore,
} from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec, TaskRecord } from "../packages/agent-contracts/src/index.js";

describe("subagent events", () => {
  const runtimeRoot = "runtime/test-subagent-events";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("执行器会等待 subagent 收尾事件后再判定 settled", async () => {
    const traceStore = new FileSystemTraceStore(runtimeRoot);
    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      traceStore,
      new FileSystemArtifactStore(runtimeRoot),
      async () => {
        let listener: ((event: Record<string, unknown>) => void) | undefined;

        return {
          subscribe(next) {
            listener = next as (event: Record<string, unknown>) => void;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            listener?.({
              type: "subagent_start",
              subagentId: "worker-1",
              role: "worker",
            });
            listener?.({ type: "agent_end" });

            setTimeout(() => {
              listener?.({
                type: "subagent_end",
                subagentId: "worker-1",
                role: "worker",
              });
            }, 20);
          },
          async abort() {
            return;
          },
          dispose() {
            return;
          },
        };
      },
    );

    const result = await executor.execute({
      task: buildTaskRecord(buildSpec()),
      spec: buildSpec(),
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("succeeded");

    const trace = await traceStore.read(result.runId);
    expect(trace).toContain('"type":"run.subagent.started"');
    expect(trace).toContain('"type":"run.subagent.finished"');
  });
});

function buildTaskRecord(spec: CompiledAgentSpec): TaskRecord {
  return {
    taskId: "task-subagent-events",
    idempotencyFingerprint: "fp-subagent-events",
    envelope: {
      taskId: "task-subagent-events",
      runRequestId: "req-subagent-events",
      idempotencyKey: "task-subagent-events",
      tenantId: "acme",
      taskType: "code.review",
      agentType: "reviewer",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 500,
      input: {
        prompt: "测试 subagent 收尾",
      },
      trace: {
        correlationId: "corr-subagent-events",
      },
    },
    compiledSpec: spec,
    status: "RUNNING",
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-subagent-events",
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
    toolPolicy: { mode: "allowlist", tools: ["read"] },
    modelPolicy: {
      providerAllowlist: ["anthropic"],
      modelAllowlist: ["claude-sonnet-4-20250514"],
      failoverOrder: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }],
    },
    workspacePolicy: {
      mode: "ephemeral",
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
    sessionReusePolicy: { mode: "none", persistent: false },
    subagentPolicy: {
      enabled: true,
      maxDepth: 1,
      maxBreadth: 4,
      maxParallel: 2,
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
    buildInfo: {
      builtAt: new Date().toISOString(),
      builtBy: "test",
      sourceDigest: "sha256:test-subagent-events",
    },
  };
}
