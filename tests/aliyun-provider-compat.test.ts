import { describe, expect, test } from "vitest";

import { resolveOpenAICompatibleCompat } from "../apps/agent-worker/src/index.js";

describe("aliyun bailian compat", () => {
  test("uses system-role compatible chat completions settings for aliyun bailian", () => {
    expect(resolveOpenAICompatibleCompat("aliyun-bailian")).toEqual({
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "openai",
    });
  });

  test("does not override compat for unrelated providers", () => {
    expect(resolveOpenAICompatibleCompat("right-codes")).toBeUndefined();
  });
});
