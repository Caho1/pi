import fs from "node:fs/promises";
import path from "node:path";

import { ensureDir, nowIso } from "../../../packages/agent-platform-shared/src/index.js";

export interface CallbackRetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface CallbackDispatcherOptions {
  runtimeRoot: string;
  retryPolicy: CallbackRetryPolicy;
  allowedDomains?: string[];
  transport?: (input: {
    url: string;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => Promise<void>;
}

export class CallbackDispatcher {
  private readonly dlqPath: string;
  private readonly transport: NonNullable<CallbackDispatcherOptions["transport"]>;

  constructor(private readonly options: CallbackDispatcherOptions) {
    this.dlqPath = path.join(options.runtimeRoot, "data", "callback-dlq.jsonl");
    this.transport =
      options.transport ??
      (async (input) => {
        const response = await fetch(input.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.headers ?? {}),
          },
          body: JSON.stringify(input.body),
        });

        if (!response.ok) {
          throw new Error(`Callback failed with ${response.status}: ${await response.text()}`);
        }
      });
  }

  async dispatch(
    url: string,
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<boolean> {
    const allowlistError = this.validateAllowedDomain(url);
    if (allowlistError) {
      await this.writeDlqEntry({
        url,
        payload,
        headers,
        attempts: 0,
        error: allowlistError,
      });
      return false;
    }

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.options.retryPolicy.maxAttempts; attempt += 1) {
      try {
        await this.transport({ url, body: payload, headers });
        return true;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.options.retryPolicy.maxAttempts) {
          await sleep(backoff(attempt, this.options.retryPolicy));
        }
      }
    }

    await this.writeDlqEntry({
      url,
      payload,
      headers,
      attempts: this.options.retryPolicy.maxAttempts,
      error: lastError?.message ?? "Unknown callback failure",
    });
    return false;
  }

  private async writeDlqEntry(entry: {
    url: string;
    payload: Record<string, unknown>;
    headers?: Record<string, string>;
    attempts: number;
    error: string;
  }): Promise<void> {
    await ensureDir(path.dirname(this.dlqPath));
    await fs.appendFile(
      this.dlqPath,
      `${JSON.stringify({
        ...entry,
        timestamp: nowIso(),
      })}\n`,
      "utf8",
    );
  }

  private validateAllowedDomain(url: string): string | undefined {
    const allowlist = this.options.allowedDomains?.filter((domain) => domain.trim().length > 0) ?? [];
    if (allowlist.length === 0) {
      return undefined;
    }

    const hostname = new URL(url).hostname;
    return allowlist.includes(hostname)
      ? undefined
      : `callback.domain_not_allowed: hostname '${hostname}' is not in the configured allowlist`;
  }
}

function backoff(attempt: number, policy: CallbackRetryPolicy): number {
  return Math.min(policy.backoffBaseMs * 2 ** (attempt - 1), policy.backoffMaxMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
