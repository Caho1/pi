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

describe("submit_result recovery", () => {
  const runtimeRoot = "runtime/test-submit-result-recovery";

  afterEach(async () => {
    delete process.env.RIGHT_CODES_API_KEY;
    delete process.env.RIGHT_CODES_BASE_URL;
    delete process.env.RIGHT_CODES_MODEL_ID;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("recovers structured output from assistant text when submit_result is omitted", async () => {
    process.env.RIGHT_CODES_API_KEY = "test-key";
    process.env.RIGHT_CODES_BASE_URL = "https://right.codes/codex/v1";
    process.env.RIGHT_CODES_MODEL_ID = "gpt-5-codex";

    const expectedStructured = {
      name: "Xinghuo Yu",
      institution: "RMIT University",
    };

    const executor = new DefaultPiExecutor(
      new DefaultPiResourceAssembler(runtimeRoot),
      new DefaultEventTranslator(),
      new FileSystemTraceStore(runtimeRoot),
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
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: `\`\`\`json\n${JSON.stringify(expectedStructured, null, 2)}\n\`\`\``,
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
    expect(result.result?.structured).toEqual(expectedStructured);
    expect(result.result?.submissionMode).toBe("submit_result");
  });
});

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-submit-result-recovery",
    agentType: "expert-profile",
    version: "1.0.0",
    displayName: "Expert Profile",
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
      providerAllowlist: ["right-codes"],
      modelAllowlist: ["gpt-5-codex"],
      failoverOrder: [{ provider: "right-codes", model: "gpt-5-codex" }],
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
      requireSubmitResultTool: true,
      textFallbackAllowed: false,
      schema: {
        type: "object",
        required: ["name", "institution"],
        properties: {
          name: { type: "string" },
          institution: { type: "string" },
        },
      },
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
      requireSubmitResult: true,
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
      sourceDigest: "sha256:test-submit-result-recovery",
    },
  };
}

function buildTaskRecord(spec: CompiledAgentSpec): TaskRecord {
  return {
    taskId: "task-submit-result-recovery",
    idempotencyFingerprint: "fp-submit-result-recovery",
    envelope: {
      taskId: "task-submit-result-recovery",
      runRequestId: "req-submit-result-recovery",
      idempotencyKey: "submit-result-recovery",
      tenantId: "acme",
      taskType: "expert.profile.extract",
      agentType: "expert-profile",
      priority: "p1",
      triggerType: "async",
      timeoutMs: 1000,
      input: { prompt: "Extract this profile" },
      trace: { correlationId: "corr-submit-result-recovery" },
    },
    compiledSpec: spec,
    status: "RUNNING",
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
