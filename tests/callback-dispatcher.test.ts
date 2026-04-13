import fs from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { CallbackDispatcher } from "../apps/agent-control-plane/src/server.js";

describe("CallbackDispatcher", () => {
  test("retries failed callbacks and writes to DLQ after exhaustion", async () => {
    const runtimeRoot = "runtime/test-callback-dispatcher";
    await fs.rm(runtimeRoot, { recursive: true, force: true });

    let attempts = 0;
    const dispatcher = new CallbackDispatcher({
      runtimeRoot,
      retryPolicy: {
        maxAttempts: 2,
        backoffBaseMs: 1,
        backoffMaxMs: 2,
      },
      transport: async () => {
        attempts += 1;
        throw new Error("network down");
      },
    });

    const delivered = await dispatcher.dispatch("https://example.com/callback", {
      taskId: "task-1",
      runId: "run-1",
      specId: "sha256:test",
      status: "failed",
      artifacts: [],
    });

    expect(delivered).toBe(false);
    expect(attempts).toBe(2);

    const dlq = await fs.readFile(`${runtimeRoot}/data/callback-dlq.jsonl`, "utf8");
    expect(dlq).toContain("task-1");
  });

  test("blocks callbacks whose domain is outside the allowlist", async () => {
    const runtimeRoot = "runtime/test-callback-dispatcher-allowlist";
    await fs.rm(runtimeRoot, { recursive: true, force: true });

    let attempts = 0;
    const dispatcher = new CallbackDispatcher({
      runtimeRoot,
      retryPolicy: {
        maxAttempts: 3,
        backoffBaseMs: 1,
        backoffMaxMs: 2,
      },
      allowedDomains: ["trusted.example.com"],
      transport: async () => {
        attempts += 1;
      },
    });

    const delivered = await dispatcher.dispatch("https://evil.example.com/callback", {
      taskId: "task-2",
      runId: "run-2",
      specId: "sha256:test",
      status: "failed",
      artifacts: [],
    });

    expect(delivered).toBe(false);
    expect(attempts).toBe(0);

    const dlq = await fs.readFile(`${runtimeRoot}/data/callback-dlq.jsonl`, "utf8");
    expect(dlq).toContain("callback.domain_not_allowed");
    expect(dlq).toContain("evil.example.com");
  });
});
