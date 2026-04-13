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

describe("subagent parallel runtime", () => {
  const runtimeRoot = "runtime/test-subagent-parallel";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("会在 maxParallel 范围内并发执行 parallel 子步骤，并把摘要回灌父任务", async () => {
    const traceStore = new FileSystemTraceStore(runtimeRoot);
    let running = 0;
    let peakConcurrency = 0;

    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      traceStore,
      new FileSystemArtifactStore(runtimeRoot),
      async ({ task }) => {
        let listener: ((event: Record<string, unknown>) => void) | undefined;

        return {
          subscribe(next) {
            listener = next as (event: Record<string, unknown>) => void;
            return () => {
              listener = undefined;
            };
          },
          async prompt(prompt) {
            const subagentId =
              typeof task.envelope.input.metadata?.subagentId === "string"
                ? task.envelope.input.metadata.subagentId
                : undefined;

            if (subagentId) {
              running += 1;
              peakConcurrency = Math.max(peakConcurrency, running);
              await new Promise((resolve) => setTimeout(resolve, subagentId === "a" ? 30 : 10));
              running -= 1;
              listener?.({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: `子步骤 ${subagentId} 完成`,
                },
              });
              listener?.({ type: "agent_end" });
              return;
            }

            expect(prompt).toContain("主任务并发汇总");
            expect(prompt).toContain("子步骤 a 完成");
            expect(prompt).toContain("子步骤 b 完成");
            listener?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "父任务已汇总并发结果",
              },
            });
            listener?.({ type: "agent_end" });
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

    const spec = buildSpec({ enabled: true, maxBreadth: 4, maxParallel: 2 });
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentMode: "parallel",
        subagentChain: [
          { id: "a", prompt: "分析方向 A" },
          { id: "b", prompt: "分析方向 B" },
        ],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("succeeded");
    expect(result.result?.text).toContain("父任务已汇总并发结果");
    expect(result.usage?.subagentCount).toBe(2);
    expect(peakConcurrency).toBe(2);

    const trace = await traceStore.read(result.runId);
    expect(trace).toContain('"type":"run.subagent.started"');
    expect(trace).toContain('"type":"run.subagent.finished"');
    expect(trace).toContain('"subagentId":"a"');
    expect(trace).toContain('"subagentId":"b"');
  });

  test("parallel 子步骤数量超过 maxParallel 时拒绝执行", async () => {
    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
      new FileSystemArtifactStore(runtimeRoot),
      async () => ({
        subscribe() {
          return () => undefined;
        },
        async prompt() {
          throw new Error("不应该执行到主 session");
        },
        async abort() {
          return;
        },
        dispose() {
          return;
        },
      }),
    );

    const spec = buildSpec({ enabled: true, maxBreadth: 4, maxParallel: 1 });
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentMode: "parallel",
        subagentChain: [
          { id: "a", prompt: "分析方向 A" },
          { id: "b", prompt: "分析方向 B" },
        ],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.stage).toBe("subagent");
    expect(result.error?.code).toBe("subagent.parallel_limit_exceeded");
  });
});

function buildTaskRecord(
  spec: CompiledAgentSpec,
  metadata?: Record<string, unknown>,
): TaskRecord {
  return {
    taskId: "task-subagent-parallel",
    idempotencyFingerprint: "fp-subagent-parallel",
    envelope: {
      taskId: "task-subagent-parallel",
      runRequestId: "req-subagent-parallel",
      idempotencyKey: "task-subagent-parallel",
      tenantId: "acme",
      taskType: "requirement.analysis",
      agentType: "requirement-analyst",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: {
        prompt: "主任务并发汇总",
        metadata,
      },
      trace: {
        correlationId: "corr-subagent-parallel",
      },
    },
    compiledSpec: spec,
    status: "RUNNING",
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildSpec(input: {
  enabled: boolean;
  maxBreadth: number;
  maxParallel: number;
}): CompiledAgentSpec {
  return {
    specId: "sha256:test-subagent-parallel",
    agentType: "requirement-analyst",
    version: "1.0.0",
    displayName: "Requirement Analyst",
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
      tools: ["read", "write", "ls"],
    },
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
    sessionReusePolicy: {
      mode: "none",
      persistent: false,
    },
    subagentPolicy: {
      enabled: input.enabled,
      maxDepth: 1,
      maxBreadth: input.maxBreadth,
      maxParallel: input.maxParallel,
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
      sourceDigest: "sha256:test-subagent-parallel",
    },
  };
}
