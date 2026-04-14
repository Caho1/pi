import path from "node:path";

import { describe, expect, test } from "vitest";

import { DefaultSpecCompiler, FileSystemAgentRegistry } from "../packages/agent-platform-shared/src/index.js";

describe("DefaultSpecCompiler", () => {
  test("compiles a deterministic immutable spec and injects submit_result guidance", async () => {
    const specsRoot = path.resolve("packages/agent-specs/agents");
    const registry = new FileSystemAgentRegistry(specsRoot);
    const compiler = new DefaultSpecCompiler({
      adapterVersion: "1.0.0",
      exactSdkVersion: "0.66.1",
    });

    const source = await registry.getSourceSpec("reviewer");
    const compiledA = await compiler.compile(source);
    const compiledB = await compiler.compile(source);

    expect(compiledA.specId).toBe(compiledB.specId);
    expect(compiledA.sdkCompatibility.exactVersion).toBe("0.66.1");
    expect(compiledA.prompts.preservePiDefaultSystemPrompt).toBe(true);
    expect(compiledA.prompts.appendSystemPrompts.join("\n")).toContain("submit_result");
    expect(compiledA.outputContract.requireSubmitResultTool).toBe(true);
    expect(compiledA.resources.skillRefs).toEqual([]);
  });
});
