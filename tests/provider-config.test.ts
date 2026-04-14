import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  loadPlatformRuntimeConfig,
  resetDotEnvLoaderForTests,
} from "../packages/agent-platform-shared/src/runtime-config.js";

describe("platform runtime config", () => {
  test("loads right-codes provider configuration from environment", () => {
    process.env.RIGHT_CODES_BASE_URL = "https://right.codes/codex/v1";
    process.env.RIGHT_CODES_MODEL_ID = "gpt-5-codex";
    process.env.RIGHT_CODES_API_KEY = "secret";
    process.env.PLATFORM_CALLBACK_ALLOWED_DOMAINS = "trusted.example.com, api.example.com ";

    const config = loadPlatformRuntimeConfig();

    expect(config.providers.rightCodes.enabled).toBe(true);
    expect(config.providers.rightCodes.baseUrl).toBe("https://right.codes/codex/v1");
    expect(config.providers.rightCodes.modelId).toBe("gpt-5-codex");
    expect(config.providers.rightCodes.apiKeyEnvVar).toBe("RIGHT_CODES_API_KEY");
    expect(config.callbacks.allowedDomains).toEqual(["trusted.example.com", "api.example.com"]);
  });

  test("loads aliyun bailian provider configuration from environment", () => {
    process.env.ALIYUN_BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    process.env.ALIYUN_BAILIAN_MODEL_ID = "glm-5";
    process.env.ALIYUN_BAILIAN_API_KEY = "secret-bailian";
    process.env.EXPERT_PROFILE_API_TOKEN = "expert-secret";

    const config = loadPlatformRuntimeConfig();

    expect(config.providers.aliyunBailian.enabled).toBe(true);
    expect(config.providers.aliyunBailian.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(config.providers.aliyunBailian.modelId).toBe("glm-5");
    expect(config.providers.aliyunBailian.api).toBe("openai-completions");
    expect(config.providers.aliyunBailian.apiKeyEnvVar).toBe("ALIYUN_BAILIAN_API_KEY");
    expect(config.businessApi.expertProfileToken).toBe("expert-secret");
  });

  test("loads right-codes provider configuration from project .env", async () => {
    const cwd = process.cwd();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-runtime-config-"));

    try {
      await fs.writeFile(
        path.join(tempDir, ".env"),
        [
          "ALIYUN_BAILIAN_API_KEY=secret-bailian-dotenv",
          "ALIYUN_BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
          "ALIYUN_BAILIAN_MODEL_ID=glm-5",
          "EXPERT_PROFILE_API_TOKEN=expert-secret-dotenv",
          "RIGHT_CODES_API_KEY=secret-from-dotenv",
          "RIGHT_CODES_BASE_URL=https://right.codes/codex/v1",
          "RIGHT_CODES_MODEL_ID=gpt-5.4",
        ].join("\n"),
      );

      delete process.env.ALIYUN_BAILIAN_API_KEY;
      delete process.env.ALIYUN_BAILIAN_BASE_URL;
      delete process.env.ALIYUN_BAILIAN_MODEL_ID;
      delete process.env.EXPERT_PROFILE_API_TOKEN;
      delete process.env.RIGHT_CODES_API_KEY;
      delete process.env.RIGHT_CODES_BASE_URL;
      delete process.env.RIGHT_CODES_MODEL_ID;
      process.chdir(tempDir);
      process.env.PWD = tempDir;
      resetDotEnvLoaderForTests();

      const config = loadPlatformRuntimeConfig();

      expect(process.env.ALIYUN_BAILIAN_API_KEY).toBe("secret-bailian-dotenv");
      expect(config.providers.aliyunBailian.enabled).toBe(true);
      expect(config.providers.aliyunBailian.modelId).toBe("glm-5");
      expect(config.providers.aliyunBailian.api).toBe("openai-completions");
      expect(config.businessApi.expertProfileToken).toBe("expert-secret-dotenv");
      expect(process.env.RIGHT_CODES_API_KEY).toBe("secret-from-dotenv");
      expect(config.providers.rightCodes.enabled).toBe(true);
      expect(config.providers.rightCodes.modelId).toBe("gpt-5.4");
    } finally {
      process.chdir(cwd);
      process.env.PWD = cwd;
      resetDotEnvLoaderForTests();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
