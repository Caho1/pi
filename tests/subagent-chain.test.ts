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

describe("subagent chain runtime", () => {
  const runtimeRoot = "runtime/test-subagent-chain";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("会按顺序执行 chain 子步骤，并把摘要回灌到父任务 prompt", async () => {
    const traceStore = new FileSystemTraceStore(runtimeRoot);
    const prompts: string[] = [];
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
            prompts.push(prompt);
            const subagentId =
              typeof task.envelope.input.metadata?.subagentId === "string"
                ? task.envelope.input.metadata.subagentId
                : undefined;

            if (subagentId === "scout") {
              emitText(listener, "发现 3 个潜在风险");
              emitTerminal(listener);
              return;
            }

            if (subagentId === "reviewer") {
              emitText(listener, "建议补 2 个回归测试");
              emitTerminal(listener);
              return;
            }

            expect(prompt).toContain("主任务最终总结");
            expect(prompt).toContain("发现 3 个潜在风险");
            expect(prompt).toContain("建议补 2 个回归测试");
            emitText(listener, "父任务已汇总子步骤结论");
            emitTerminal(listener);
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
      task: buildTaskRecord(
        buildSpec({
          enabled: true,
          maxBreadth: 4,
        }),
        {
          subagentChain: [
            {
              id: "scout",
              role: "scout",
              prompt: "先做风险摸排",
            },
            {
              id: "reviewer",
              role: "reviewer",
              prompt: "再给出测试建议",
            },
          ],
        },
      ),
      spec: buildSpec({
        enabled: true,
        maxBreadth: 4,
      }),
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("succeeded");
    expect(result.result?.text).toContain("父任务已汇总子步骤结论");
    expect(result.usage?.subagentCount).toBe(2);
    expect(prompts[0]).toBe("先做风险摸排");
    expect(prompts[1]).toBe("再给出测试建议");
    expect(prompts[2]).toContain("发现 3 个潜在风险");
    expect(prompts[2]).toContain("建议补 2 个回归测试");

    const trace = await traceStore.read(result.runId);
    expect(trace).toContain('"type":"run.subagent.started"');
    expect(trace).toContain('"type":"run.subagent.finished"');
    expect(trace).toContain('"subagentId":"scout"');
    expect(trace).toContain('"subagentId":"reviewer"');

    const summaryArtifact = result.artifacts.find((artifact) => artifact.kind === "subagent-summary");
    expect(summaryArtifact?.uri).toBeDefined();
    const summaryText = await fs.readFile(summaryArtifact!.uri, "utf8");
    expect(summaryText).toContain("发现 3 个潜在风险");
    expect(summaryText).toContain("建议补 2 个回归测试");
  });

  test("当 spec 未开启 subagentPolicy 时拒绝 chain 计划", async () => {
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

    const spec = buildSpec({
      enabled: false,
      maxBreadth: 1,
    });
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentChain: [{ id: "scout", prompt: "先摸排" }],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.stage).toBe("subagent");
    expect(result.error?.code).toBe("subagent.disabled");
  });

  test("当 chain 超过 maxBreadth 时拒绝执行", async () => {
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

    const spec = buildSpec({
      enabled: true,
      maxBreadth: 1,
    });
    const result = await executor.execute({
      task: buildTaskRecord(spec, {
        subagentChain: [
          { id: "scout", prompt: "先摸排" },
          { id: "reviewer", prompt: "再复核" },
        ],
      }),
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.stage).toBe("subagent");
    expect(result.error?.code).toBe("subagent.breadth_exceeded");
  });
});

function emitText(listener: ((event: Record<string, unknown>) => void) | undefined, delta: string): void {
  listener?.({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta,
    },
  });
}

function emitTerminal(listener: ((event: Record<string, unknown>) => void) | undefined): void {
  listener?.({ type: "agent_end" });
}

function buildTaskRecord(
  spec: CompiledAgentSpec,
  metadata?: Record<string, unknown>,
): TaskRecord {
  return {
    taskId: "task-subagent-chain",
    idempotencyFingerprint: "fp-subagent-chain",
    envelope: {
      taskId: "task-subagent-chain",
      runRequestId: "req-subagent-chain",
      idempotencyKey: "task-subagent-chain",
      tenantId: "acme",
      taskType: "requirement.analysis",
      agentType: "requirement-analyst",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: {
        prompt: "主任务最终总结",
        metadata,
      },
      trace: {
        correlationId: "corr-subagent-chain",
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
}): CompiledAgentSpec {
  return {
    specId: "sha256:test-subagent-chain",
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
    buildInfo: {
      builtAt: new Date().toISOString(),
      builtBy: "test",
      sourceDigest: "sha256:test-subagent-chain",
    },
  };
}
