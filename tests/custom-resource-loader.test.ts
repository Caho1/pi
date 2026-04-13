import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DefaultPiResourceAssembler } from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec, TaskEnvelope } from "../packages/agent-contracts/src/index.js";

describe("custom resource loader", () => {
  const runtimeRoot = "runtime/test-custom-resource-loader";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("会按租户资源视图和显式覆盖构造自定义资源加载器", async () => {
    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    const viewDir = path.resolve(runtimeRoot, "resource-views", "acme");
    await fs.mkdir(viewDir, { recursive: true });
    await fs.writeFile(
      path.join(viewDir, "analyst-cn.json"),
      JSON.stringify(
        {
          appendSystemPrompts: ["# 租户视图\n请优先输出中文结构化结论"],
          agentsFiles: [
            {
              path: "TENANT.md",
              content: "这是租户级远程上下文",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const runtime = await assembler.assemble({
      spec: buildSpec(),
      workspacePath: path.resolve(runtimeRoot, "workspace"),
      tenantId: "acme",
      task: buildTask({
        resourceView: "analyst-cn",
        resourceOverrides: {
          appendSystemPrompts: ["# 运行时覆盖\n本次任务要求突出风险和假设"],
          agentsFiles: [
            {
              path: "OVERRIDE.md",
              content: "这是本次任务的临时上下文",
            },
          ],
        },
      }),
    });

    const appendPrompts = runtime.resourceLoader.getAppendSystemPrompt();
    const agentsFiles = runtime.resourceLoader.getAgentsFiles().agentsFiles;

    expect(appendPrompts.join("\n")).toContain("# 基础规范");
    expect(appendPrompts.join("\n")).toContain("请优先输出中文结构化结论");
    expect(appendPrompts.join("\n")).toContain("本次任务要求突出风险和假设");
    expect(agentsFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "BASE.md", content: "基础 agents file" }),
        expect.objectContaining({ path: "TENANT.md", content: "这是租户级远程上下文" }),
        expect.objectContaining({ path: "OVERRIDE.md", content: "这是本次任务的临时上下文" }),
      ]),
    );
  });

  test("当租户资源视图不存在时返回明确错误", async () => {
    const assembler = new DefaultPiResourceAssembler(runtimeRoot);

    await expect(
      assembler.assemble({
        spec: buildSpec(),
        workspacePath: path.resolve(runtimeRoot, "workspace-missing"),
        tenantId: "acme",
        task: buildTask({
          resourceView: "missing-view",
        }),
      }),
    ).rejects.toMatchObject({
      stage: "platform",
      code: "resource_loader.view_not_found",
    });
  });
});

function buildTask(metadata?: Record<string, unknown>): TaskEnvelope {
  return {
    taskId: "task-custom-loader",
    runRequestId: "req-custom-loader",
    idempotencyKey: "task-custom-loader",
    tenantId: "acme",
    taskType: "requirement.analysis",
    agentType: "requirement-analyst",
    priority: "p1",
    triggerType: "async",
    timeoutMs: 1000,
    input: {
      prompt: "分析这个需求",
      metadata,
    },
    trace: {
      correlationId: "corr-custom-loader",
    },
  };
}

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-custom-loader",
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
      appendSystemPrompts: ["# 基础规范\n请先给出摘要"],
      agentsFiles: [{ path: "BASE.md", content: "基础 agents file" }],
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
    buildInfo: {
      builtAt: new Date().toISOString(),
      builtBy: "test",
      sourceDigest: "sha256:test-custom-loader",
    },
  };
}
