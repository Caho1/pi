import { describe, expect, test } from "vitest";

import { loadPlatformRuntimeConfig } from "../packages/agent-platform-shared/src/runtime-config.js";

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
});
