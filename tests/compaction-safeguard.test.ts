import { describe, expect, test } from "vitest";

import { createSafeguardCompactionExtension } from "../apps/agent-worker/src/index.js";
import type { CompiledAgentSpec } from "../packages/agent-contracts/src/index.js";

describe("safeguard compaction extension", () => {
  test("preserves recent turns and tool outputs in the custom compaction summary", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
    createSafeguardCompactionExtension(buildSpec())({
      on(event, handler) {
        handlers.set(event, handler as (event: Record<string, unknown>) => unknown);
      },
    });

    const beforeCompact = handlers.get("session_before_compact");
    expect(beforeCompact).toBeDefined();

    const result = await beforeCompact?.({
      preparation: {
        firstKeptEntryId: "entry-4",
        tokensBefore: 2048,
        previousSummary: "Previous audit context",
        fileOps: {
          readFiles: ["README.md"],
          modifiedFiles: ["src/index.ts"],
        },
        messagesToSummarize: [
          { role: "user", content: "We need a code review focused on security." },
          { role: "assistant", content: "I will review the auth and input validation paths." },
          { role: "tool", toolName: "read", content: "src/auth.ts contents" },
        ],
        turnPrefixMessages: [
          { role: "user", content: "Pay extra attention to token refresh logic." },
          { role: "assistant", content: "I found one risky branch in refreshToken()." },
          { role: "tool", toolName: "grep", content: "refreshToken matched in src/auth.ts:42" },
        ],
      },
    });

    expect(result).toBeDefined();
    const compaction = (result as { compaction: { summary: string; details?: Record<string, unknown> } }).compaction;
    expect(compaction.summary).toContain("Safeguard Compaction Summary");
    expect(compaction.summary).toContain("Previous audit context");
    expect(compaction.summary).toContain("Protected Recent Turns");
    expect(compaction.summary).toContain("Pay extra attention to token refresh logic.");
    expect(compaction.summary).toContain("Protected Tool Outputs");
    expect(compaction.summary).toContain("refreshToken matched in src/auth.ts:42");
    expect(compaction.summary).toContain("Older Context Summary");
    expect(compaction.details).toMatchObject({
      mode: "safeguard",
      preserveRecentTurns: 1,
      preserveToolOutputs: true,
    });
  });

  test("can omit protected tool output section when the policy disables it", async () => {
    const handlers = new Map<string, (event: Record<string, unknown>) => unknown>();
    const spec = buildSpec();
    spec.compactionPolicy.preserveToolOutputs = false;

    createSafeguardCompactionExtension(spec)({
      on(event, handler) {
        handlers.set(event, handler as (event: Record<string, unknown>) => unknown);
      },
    });

    const result = await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "entry-2",
        tokensBefore: 512,
        fileOps: {
          readFiles: [],
          modifiedFiles: [],
        },
        messagesToSummarize: [{ role: "tool", toolName: "read", content: "secret" }],
        turnPrefixMessages: [],
      },
    });

    const summary = (result as { compaction: { summary: string } }).compaction.summary;
    expect(summary).not.toContain("Protected Tool Outputs");
  });
});

function buildSpec(): CompiledAgentSpec {
  return {
    specId: "sha256:test-safeguard",
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
      mode: "safeguard",
      preserveToolOutputs: true,
      preserveRecentTurns: 1,
      summarizeOlderThanTurns: 1,
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
      sourceDigest: "sha256:test-safeguard",
    },
  };
}
