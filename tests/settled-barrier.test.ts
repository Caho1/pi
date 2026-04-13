import { describe, expect, test } from "vitest";

import { createRunSettledBarrier } from "../apps/agent-worker/src/index.js";

describe("RunSettledBarrier", () => {
  test("waits for prompt resolution, terminal event, background work, and finalizers", async () => {
    let finalizerRan = false;
    const barrier = createRunSettledBarrier({
      requirePromptResolved: true,
      requireTerminalEvent: true,
      requireNoPendingWork: true,
      requireSubmitResult: false,
      settledTimeoutMs: 500,
    });

    barrier.markBackgroundWorkStarted("artifact-flush");
    barrier.addFinalizer(async () => {
      finalizerRan = true;
      return true;
    });

    const waiting = barrier.waitUntilSettled(500);
    barrier.markPromptResolved();
    barrier.markTerminalEvent("agent_end");
    barrier.markBackgroundWorkFinished("artifact-flush");

    await expect(waiting).resolves.toBeUndefined();
    expect(finalizerRan).toBe(true);
  });

  test("times out when terminal conditions are never met", async () => {
    const barrier = createRunSettledBarrier({
      requirePromptResolved: true,
      requireTerminalEvent: true,
      requireNoPendingWork: true,
      requireSubmitResult: false,
      settledTimeoutMs: 50,
    });

    barrier.markPromptResolved();

    await expect(barrier.waitUntilSettled(50)).rejects.toThrow(/settled/i);
  });
});
