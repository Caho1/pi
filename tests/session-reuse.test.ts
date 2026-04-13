import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DefaultPiResourceAssembler } from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec, TaskEnvelope } from "../packages/agent-contracts/src/index.js";

describe("session reuse policy", () => {
  const runtimeRoot = "runtime/test-session-reuse";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("within-task 模式会为同一个任务复用稳定的持久化 session 目录", async () => {
    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    const spec = buildSpec({
      mode: "within-task",
      persistent: true,
    });

    const runtime1 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "workspace-a"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-1"),
    });
    const runtime2 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "workspace-b"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-1"),
    });
    const runtime3 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "workspace-c"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-2"),
    });

    expect(runtime1.sessionManager.isPersisted()).toBe(true);
    expect(runtime2.sessionManager.isPersisted()).toBe(true);
    expect(runtime1.sessionManager.getSessionDir()).toBe(runtime2.sessionManager.getSessionDir());
    expect(runtime1.sessionManager.getSessionDir()).not.toBe(runtime3.sessionManager.getSessionDir());
    expect(runtime1.sessionManager.getSessionDir()).toContain(path.join("sessions", "acme", "task-1"));
  });

  test("within-thread 模式会按对话线程跨任务复用持久化 session 目录", async () => {
    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    const spec = buildSpec({
      mode: "within-thread",
      persistent: true,
    });

    const runtime1 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "thread-workspace-a"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-thread-1", {
        correlationId: "thread-1",
      }),
    });
    const runtime2 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "thread-workspace-b"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-thread-2", {
        correlationId: "thread-1",
        parentTaskId: "task-thread-1",
      }),
    });
    const runtime3 = await assembler.assemble({
      spec,
      workspacePath: path.resolve(runtimeRoot, "thread-workspace-c"),
      tenantId: "acme",
      task: buildTaskEnvelope("task-thread-3", {
        correlationId: "thread-2",
        parentTaskId: "task-thread-1",
      }),
    });

    expect(runtime1.sessionManager.isPersisted()).toBe(true);
    expect(runtime1.sessionManager.getSessionDir()).toBe(runtime2.sessionManager.getSessionDir());
    expect(runtime1.sessionManager.getSessionDir()).not.toBe(runtime3.sessionManager.getSessionDir());
    expect(runtime1.sessionManager.getSessionDir()).toContain(path.join("sessions", "acme", "thread-1"));
  });
});

function buildTaskEnvelope(
  taskId: string,
  options?: {
    correlationId?: string;
    parentTaskId?: string;
  },
): TaskEnvelope {
  return {
    taskId,
    runRequestId: `req-${taskId}`,
    idempotencyKey: taskId,
    tenantId: "acme",
    taskType: "code.review",
    agentType: "reviewer",
    priority: "p1",
    triggerType: "async",
    timeoutMs: 1000,
    input: {
      prompt: "复用 session",
    },
    trace: {
      correlationId: options?.correlationId ?? `corr-${taskId}`,
      parentTaskId: options?.parentTaskId,
    },
  };
}

function buildSpec(sessionReusePolicy: CompiledAgentSpec["sessionReusePolicy"]): CompiledAgentSpec {
  return {
    specId: "sha256:test-session-reuse",
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
    sessionReusePolicy,
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
      settledTimeoutMs: 50,
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
      sourceDigest: "sha256:test-session-reuse",
    },
  };
}
