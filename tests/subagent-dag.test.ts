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

describe("subagent dag runtime", () => {
  const runtimeRoot = "runtime/test-subagent-dag";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("会按 dag 依赖分层执行子步骤", async () => {
    const executionOrder: string[] = [];
    let running = 0;
    let peakConcurrency = 0;

    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
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
              executionOrder.push(`start:${subagentId}`);
              running += 1;
              peakConcurrency = Math.max(peakConcurrency, running);
              await new Promise((resolve) => setTimeout(resolve, subagentId === "root" ? 20 : 10));
              running -= 1;
              executionOrder.push(`finish:${subagentId}`);
              listener?.({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: `步骤 ${subagentId} 完成`,
                },
              });
              listener?.({ type: "agent_end" });
              return;
            }

            expect(prompt).toContain("步骤 root 完成");
            expect(prompt).toContain("步骤 left 完成");
            expect(prompt).toContain("步骤 right 完成");
            listener?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "父任务已汇总 DAG 结果",
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

    const spec = buildSpec();
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentMode: "dag-lite",
        subagentChain: [
          { id: "root", prompt: "先做根分析" },
          { id: "left", prompt: "左分支分析", dependsOn: ["root"] },
          { id: "right", prompt: "右分支分析", dependsOn: ["root"] },
        ],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("succeeded");
    expect(result.result?.text).toContain("父任务已汇总 DAG 结果");
    expect(result.usage?.subagentCount).toBe(3);
    expect(peakConcurrency).toBe(2);
    expect(executionOrder.indexOf("finish:root")).toBeLessThan(executionOrder.indexOf("start:left"));
    expect(executionOrder.indexOf("finish:root")).toBeLessThan(executionOrder.indexOf("start:right"));
  });

  test("当 dag 出现循环依赖时拒绝执行", async () => {
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

    const spec = buildSpec();
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentMode: "dag-lite",
        subagentChain: [
          { id: "a", prompt: "A", dependsOn: ["b"] },
          { id: "b", prompt: "B", dependsOn: ["a"] },
        ],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.stage).toBe("subagent");
    expect(result.error?.code).toBe("subagent.cycle_detected");
  });
});

function buildTaskRecord(
  spec: CompiledAgentSpec,
  metadata?: Record<string, unknown>,
): TaskRecord {
  return {
    taskId: "task-subagent-dag",
    idempotencyFingerprint: "fp-subagent-dag",
    envelope: {
      taskId: "task-subagent-dag",
      runRequestId: "req-subagent-dag",
      idempotencyKey: "task-subagent-dag",
      tenantId: "acme",
      taskType: "requirement.analysis",
      agentType: "requirement-analyst",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: {
        prompt: "主任务 DAG 汇总",
        metadata,
      },
      trace: {
        correlationId: "corr-subagent-dag",
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
    specId: "sha256:test-subagent-dag",
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
      enabled: true,
      maxDepth: 2,
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
      sourceDigest: "sha256:test-subagent-dag",
    },
  };
}
