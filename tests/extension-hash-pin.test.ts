import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { DefaultPiResourceAssembler } from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec } from "../packages/agent-contracts/src/index.js";
import {
  DefaultSpecCompiler,
  FileSystemAgentRegistry,
} from "../packages/agent-platform-shared/src/index.js";

describe("extension hash pin", () => {
  const runtimeRoot = "runtime/test-extension-hash-pin";
  const specsRoot = path.join(runtimeRoot, "agent-specs");
  const agentDir = path.join(specsRoot, "hash-pin-agent");
  const extensionFile = path.resolve(runtimeRoot, "extensions", "pin-check.ts");

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("扩展文件内容变化后会改变编译产物的 specId", async () => {
    await writeAgentSpec("export default function () { return 'v1'; }\n");

    const registry = new FileSystemAgentRegistry(specsRoot);
    const compiler = new DefaultSpecCompiler({
      exactSdkVersion: "0.66.1",
      adapterVersion: "1.0.0",
    });

    const sourceV1 = await registry.getSourceSpec("hash-pin-agent");
    const compiledV1 = await compiler.compile(sourceV1);

    await fs.writeFile(extensionFile, "export default function () { return 'v2'; }\n", "utf8");

    const sourceV2 = await registry.getSourceSpec("hash-pin-agent");
    const compiledV2 = await compiler.compile(sourceV2);

    expect(compiledV2.specId).not.toBe(compiledV1.specId);
  });

  test("运行时会拦截和 spec 指纹不一致的扩展文件", async () => {
    await writeAgentSpec("export default function () { return 'locked'; }\n");

    const registry = new FileSystemAgentRegistry(specsRoot);
    const compiler = new DefaultSpecCompiler({
      exactSdkVersion: "0.66.1",
      adapterVersion: "1.0.0",
    });
    const source = await registry.getSourceSpec("hash-pin-agent");
    const compiled = await compiler.compile(source);

    await fs.writeFile(extensionFile, "export default function () { return 'mutated'; }\n", "utf8");

    const assembler = new DefaultPiResourceAssembler(runtimeRoot);
    await expect(
      assembler.assemble({
        spec: compiled as CompiledAgentSpec,
        workspacePath: path.resolve(runtimeRoot, "workspace"),
        tenantId: "acme",
        task: {
          taskId: "task-hash-pin",
          runRequestId: "req-hash-pin",
          idempotencyKey: "hash-pin",
          tenantId: "acme",
          taskType: "code.review",
          agentType: "reviewer",
          priority: "p1",
          triggerType: "async",
          timeoutMs: 1000,
          input: {
            prompt: "检查扩展",
          },
          trace: {
            correlationId: "corr-hash-pin",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "extension.hash_mismatch",
    });
  });

  async function writeAgentSpec(extensionContent: string): Promise<void> {
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(path.dirname(extensionFile), { recursive: true });
    await fs.writeFile(extensionFile, extensionContent, "utf8");
    await fs.writeFile(
      path.join(agentDir, "policy.json"),
      JSON.stringify(
        {
          agentType: "hash-pin-agent",
          version: "1.0.0",
          displayName: "Hash Pin Agent",
          skillRefs: [],
          extensionRefs: [extensionFile],
          promptTemplates: [],
          defaultModelPolicy: {
            providerAllowlist: ["anthropic"],
            modelAllowlist: ["claude-sonnet-4-20250514"],
            failoverOrder: [{ provider: "anthropic", model: "claude-sonnet-4-20250514" }],
          },
          defaultToolPolicy: {
            mode: "allowlist",
            tools: ["read"],
          },
          defaultWorkspacePolicy: {
            mode: "ephemeral",
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
            allowedExtensionRefs: [extensionFile],
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
});
