import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DefaultPiResourceAssembler,
  FileSystemWorkspaceManager,
} from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec, TaskEnvelope } from "../packages/agent-contracts/src/index.js";

describe("tenant isolation", () => {
  const runtimeRoot = "runtime/test-tenant-isolation";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("sanitizes tenant-derived runtime paths to stay inside the platform runtime root", async () => {
    process.env.RIGHT_CODES_API_KEY = "test-key";
    process.env.RIGHT_CODES_BASE_URL = "https://right.codes/codex/v1";
    process.env.RIGHT_CODES_MODEL_ID = "gpt-5-codex";

    const tenantId = "../evil/../../outside";
    const workspaceManager = new FileSystemWorkspaceManager(runtimeRoot);
    const workspace = await workspaceManager.prepare({
      taskId: "task-tenant-1",
      tenantId,
      mode: "readonly",
    });

    const workspacesRoot = path.resolve(runtimeRoot, "workspaces");
    expect(path.relative(workspacesRoot, workspace.path).startsWith("..")).toBe(false);

    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    const runtime = await assembler.assemble({
      spec: buildSpec(),
      workspacePath: workspace.path,
      tenantId,
      task: buildTaskEnvelope("task-tenant-1", tenantId),
    });
    const sessionDir = runtime.sessionManager.getSessionDir();

    expect(path.relative(path.resolve(runtimeRoot, "sessions"), sessionDir).startsWith("..")).toBe(false);
    expect(sessionDir).not.toContain("..");
  });
});

function buildTaskEnvelope(taskId: string, tenantId: string): TaskEnvelope {
  return {
    taskId,
    runRequestId: `req-${taskId}`,
    idempotencyKey: taskId,
    tenantId,
    taskType: "code.review",
    agentType: "reviewer",
    priority: "p1",
    triggerType: "async",
    timeoutMs: 1000,
    input: {
      prompt: "隔离测试",
    },
    trace: {
      correlationId: `corr-${taskId}`,
    },
  };
}

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-tenant-isolation",
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
      modelAllowlist: ["gpt-5-codex"],
      failoverOrder: [{ provider: "right-codes", model: "gpt-5-codex" }],
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
      mode: "within-task",
      persistent: true,
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
      builtAt: "2026-04-14T02:40:00.000Z",
      builtBy: "test",
      sourceDigest: "sha256:test",
    },
  };
}
