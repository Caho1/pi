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
import { createPlatformError } from "../packages/agent-platform-shared/src/index.js";

describe("provider failover", () => {
  const runtimeRoot = "runtime/test-provider-failover";

  afterEach(async () => {
    delete process.env.RIGHT_CODES_API_KEY;
    delete process.env.RIGHT_CODES_BASE_URL;
    delete process.env.RIGHT_CODES_MODEL_ID;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("fails over to the next provider after a transient model failure", async () => {
    process.env.RIGHT_CODES_API_KEY = "test-key";
    process.env.RIGHT_CODES_BASE_URL = "https://right.codes/codex/v1";
    process.env.RIGHT_CODES_MODEL_ID = "gpt-5-codex";

    const attempts: string[] = [];
    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
      new FileSystemArtifactStore(runtimeRoot),
      async ({ runtime }) => {
        let listener: ((event: Record<string, unknown>) => void) | undefined;
        const provider = (runtime.model as { provider?: string }).provider ?? "unknown";
        const modelId = (runtime.model as { id?: string }).id ?? "unknown";

        return {
          subscribe(next) {
            listener = next as (event: Record<string, unknown>) => void;
            return () => {
              listener = undefined;
            };
          },
          async prompt() {
            attempts.push(`${provider}:${modelId}`);
            if (provider === "right-codes") {
              throw createPlatformError({
                stage: "model",
                code: "provider.rate_limited",
                message: "429 from primary provider",
                retryable: true,
              });
            }

            listener?.({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "fallback provider succeeded",
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

    const result = await executor.execute({
      task: buildTaskRecord(buildSpec()),
      spec: buildSpec(),
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("succeeded");
    expect(result.result?.text).toContain("fallback provider succeeded");
    expect(result.diagnostics?.failoverAttempts).toBe(1);
    expect(result.diagnostics?.failures).toEqual([
      {
        stage: "model",
        code: "provider.rate_limited",
        message: "429 from primary provider",
        retryable: true,
      },
    ]);
    expect(result.usage?.provider).toBe("anthropic");
    expect(result.usage?.model).toBe("claude-sonnet-4-20250514");
    expect(attempts).toEqual(["right-codes:gpt-5-codex", "anthropic:claude-sonnet-4-20250514"]);
  });

  test("does not fail over for non-provider execution errors", async () => {
    process.env.RIGHT_CODES_API_KEY = "test-key";
    process.env.RIGHT_CODES_BASE_URL = "https://right.codes/codex/v1";
    process.env.RIGHT_CODES_MODEL_ID = "gpt-5-codex";

    const attempts: string[] = [];
    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
      new FileSystemArtifactStore(runtimeRoot),
      async ({ runtime }) => ({
        subscribe() {
          return () => undefined;
        },
        async prompt() {
          attempts.push((runtime.model as { provider?: string }).provider ?? "unknown");
          throw createPlatformError({
            stage: "tool",
            code: "submit_result.protocol_violation",
            message: "tool contract broken",
            retryable: false,
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

    const result = await executor.execute({
      task: buildTaskRecord(buildSpec()),
      spec: buildSpec(),
      workspacePath: runtimeRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("submit_result.protocol_violation");
    expect(result.diagnostics?.failoverAttempts).toBe(0);
    expect(attempts).toEqual(["right-codes"]);
  });
});

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-provider-failover",
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
      providerAllowlist: ["right-codes", "anthropic"],
      modelAllowlist: ["gpt-5-codex", "claude-sonnet-4-20250514"],
      failoverOrder: [
        { provider: "right-codes", model: "gpt-5-codex" },
        { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      ],
      maxAttemptsPerProvider: 1,
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
      sourceDigest: "sha256:test-provider-failover",
    },
  };
}

function buildTaskRecord(spec: CompiledAgentSpec): TaskRecord {
  return {
    taskId: "task-provider-failover",
    idempotencyFingerprint: "fp-provider-failover",
    envelope: {
      taskId: "task-provider-failover",
      runRequestId: "req-provider-failover",
      idempotencyKey: "provider-failover",
      tenantId: "acme",
      taskType: "code.review",
      agentType: "reviewer",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: { prompt: "Review this change" },
      trace: { correlationId: "corr-provider-failover" },
    },
    compiledSpec: spec,
    status: "RUNNING",
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
