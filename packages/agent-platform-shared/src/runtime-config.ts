export interface RightCodesProviderConfig {
  enabled: boolean;
  providerName: "right-codes";
  baseUrl: string;
  modelId: string;
  apiKeyEnvVar: string;
  api: "openai-responses";
}

export interface PlatformRuntimeConfig {
  providers: {
    rightCodes: RightCodesProviderConfig;
  };
  callbacks: {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    allowedDomains: string[];
  };
}

export function loadPlatformRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PlatformRuntimeConfig {
  const apiKeyEnvVar = "RIGHT_CODES_API_KEY";

  return {
    providers: {
      rightCodes: {
        enabled: Boolean(env[apiKeyEnvVar] || env.RIGHT_CODES_BASE_URL || env.RIGHT_CODES_MODEL_ID),
        providerName: "right-codes",
        baseUrl: env.RIGHT_CODES_BASE_URL ?? "https://right.codes/codex/v1",
        modelId: env.RIGHT_CODES_MODEL_ID ?? "gpt-5-codex",
        apiKeyEnvVar,
        api: "openai-responses",
      },
    },
    callbacks: {
      maxAttempts: Number(env.PLATFORM_CALLBACK_MAX_ATTEMPTS ?? "3"),
      backoffBaseMs: Number(env.PLATFORM_CALLBACK_BACKOFF_BASE_MS ?? "250"),
      backoffMaxMs: Number(env.PLATFORM_CALLBACK_BACKOFF_MAX_MS ?? "2000"),
      allowedDomains: (env.PLATFORM_CALLBACK_ALLOWED_DOMAINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    },
  };
}
