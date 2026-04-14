import fs from "node:fs";
import path from "node:path";

export interface OpenAICompatibleProviderConfig {
  enabled: boolean;
  providerName: "right-codes" | "aliyun-bailian";
  baseUrl: string;
  modelId: string;
  apiKeyEnvVar: string;
  api: "openai-responses" | "openai-completions";
}

export interface PlatformRuntimeConfig {
  providers: {
    rightCodes: OpenAICompatibleProviderConfig;
    aliyunBailian: OpenAICompatibleProviderConfig;
  };
  businessApi: {
    expertProfileToken?: string;
  };
  callbacks: {
    maxAttempts: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    allowedDomains: string[];
  };
}

let dotenvLoaded = false;

function loadDotEnvIntoProcessEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (dotenvLoaded) {
    return;
  }
  dotenvLoaded = true;

  let search = path.resolve(env.PWD ?? process.cwd());
  for (let i = 0; i < 8; i += 1) {
    const envFile = path.join(search, ".env");
    if (fs.existsSync(envFile) && fs.statSync(envFile).isFile()) {
      const content = fs.readFileSync(envFile, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          continue;
        }
        const separator = line.indexOf("=");
        if (separator <= 0) {
          continue;
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && value && env[key] === undefined) {
          process.env[key] = value;
          env[key] = value;
        }
      }
      return;
    }

    const parent = path.dirname(search);
    if (parent === search) {
      return;
    }
    search = parent;
  }
}

export function resetDotEnvLoaderForTests(): void {
  dotenvLoaded = false;
}

function firstPresentEnvName(
  env: NodeJS.ProcessEnv,
  candidates: string[],
  fallback: string,
): string {
  return candidates.find((name) => Boolean(env[name])) ?? fallback;
}

export function loadPlatformRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PlatformRuntimeConfig {
  loadDotEnvIntoProcessEnv(env);
  const rightCodesApiKeyEnvVar = "RIGHT_CODES_API_KEY";
  const aliyunApiKeyEnvVar = firstPresentEnvName(
    env,
    ["ALIYUN_BAILIAN_API_KEY", "DASHSCOPE_API_KEY"],
    "ALIYUN_BAILIAN_API_KEY",
  );

  return {
    providers: {
      rightCodes: {
        enabled: Boolean(env[rightCodesApiKeyEnvVar] || env.RIGHT_CODES_BASE_URL || env.RIGHT_CODES_MODEL_ID),
        providerName: "right-codes",
        baseUrl: env.RIGHT_CODES_BASE_URL ?? "https://right.codes/codex/v1",
        modelId: env.RIGHT_CODES_MODEL_ID ?? "gpt-5-codex",
        apiKeyEnvVar: rightCodesApiKeyEnvVar,
        api: "openai-responses",
      },
      aliyunBailian: {
        enabled: Boolean(
          env[aliyunApiKeyEnvVar] ||
            env.ALIYUN_BAILIAN_BASE_URL ||
            env.DASHSCOPE_BASE_URL ||
            env.ALIYUN_BAILIAN_MODEL_ID ||
            env.DASHSCOPE_MODEL ||
            env.DASHSCOPE_MODEL_ID,
        ),
        providerName: "aliyun-bailian",
        baseUrl:
          env.ALIYUN_BAILIAN_BASE_URL ??
          env.DASHSCOPE_BASE_URL ??
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId:
          env.ALIYUN_BAILIAN_MODEL_ID ??
          env.DASHSCOPE_MODEL ??
          env.DASHSCOPE_MODEL_ID ??
          "glm-5",
        apiKeyEnvVar: aliyunApiKeyEnvVar,
        api: "openai-completions",
      },
    },
    businessApi: {
      expertProfileToken: env.EXPERT_PROFILE_API_TOKEN?.trim() || undefined,
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
