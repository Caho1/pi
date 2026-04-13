import { describe, expect, test } from "vitest";

import {
  DefaultEventTranslator,
  DefaultPiExecutor,
  DefaultPiResourceAssembler,
  FileSystemArtifactStore,
  FileSystemTraceStore,
} from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec, TaskRecord } from "../packages/agent-contracts/src/index.js";

describe("DefaultPiExecutor timeout", () => {
  test("aborts a run when task timeout is exceeded", async () => {
    const runtimeRoot = "runtime/test-executor-timeout";
    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    const executor = new DefaultPiExecutor(
      assembler,
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
      new FileSystemArtifactStore(runtimeRoot),
      async ({ runtime }) => ({
        subscribe() {
          return () => undefined;
        },
        async prompt() {
          await new Promise((_, reject) => {
            runtime.abortGraph.root.signal.addEventListener("abort", () => {
              reject(runtime.abortGraph.root.signal.reason);
            });
          });
        },
        async abort() {
          return;
        },
        dispose() {
          return;
        },
      }),
    );

    const spec: CompiledAgentSpec = {
      specId: "sha256:test",
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
        settledTimeoutMs: 10,
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
        sourceDigest: "sha256:test",
      },
    };

    const task: TaskRecord = {
      taskId: "task-timeout",
      idempotencyFingerprint: "fp",
      envelope: {
        taskId: "task-timeout",
        runRequestId: "req-timeout",
        idempotencyKey: "timeout",
        tenantId: "acme",
        taskType: "code.review",
        agentType: "reviewer",
        priority: "p1",
        triggerType: "async",
        timeoutMs: 10,
        input: { prompt: "slow task" },
        trace: { correlationId: "corr-timeout" },
      },
      compiledSpec: spec,
      status: "RUNNING",
      artifacts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await executor.execute({
      task,
      spec,
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("run.timeout");
  });
});
