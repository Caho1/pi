import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RunResult, TaskRecord } from "../../../packages/agent-contracts/src/index.js";
import type { TaskProcessor } from "../../agent-worker/src/index.js";

interface RpcRequest {
  id: string;
  method: "process" | "cancel";
  params: {
    task?: TaskRecord;
    taskId?: string;
  };
}

interface RpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: {
    message: string;
  };
}

export class RpcTaskProcessorClient implements TaskProcessor {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(
    private readonly options: {
      command: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  async process(task: TaskRecord): Promise<RunResult> {
    return this.send<RunResult>({
      method: "process",
      params: { task },
    });
  }

  async cancel(taskId: string): Promise<boolean> {
    return this.send<boolean>({
      method: "cancel",
      params: { taskId },
    });
  }

  async dispose(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = undefined;
    this.startPromise = undefined;
    for (const entry of this.pending.values()) {
      entry.reject(new Error("RPC worker was disposed"));
    }
    this.pending.clear();

    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 500).unref();
    });
  }

  private async send<T>(input: Omit<RpcRequest, "id">): Promise<T> {
    await this.ensureStarted();
    if (!this.child) {
      throw new Error("RPC worker is not available");
    }

    const id = randomUUID();
    const payload: RpcRequest = {
      id,
      ...input,
    };

    const responsePromise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return responsePromise;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args ?? [], {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: "pipe",
      });
      this.child = child;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.handleStdoutChunk(chunk);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderrBuffer += chunk;
      });

      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(error));
      child.on("exit", (code, signal) => {
        const reason = signal
          ? `RPC worker exited from signal ${signal}`
          : `RPC worker exited with code ${code ?? "unknown"}`;
        const suffix = this.stderrBuffer.trim().length > 0 ? `\n${this.stderrBuffer.trim()}` : "";
        const error = new Error(`${reason}${suffix}`);
        for (const entry of this.pending.values()) {
          entry.reject(error);
        }
        this.pending.clear();
        this.child = undefined;
        this.startPromise = undefined;
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
      });
    });

    return this.startPromise;
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleResponse(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleResponse(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch (error) {
      const parseError = new Error(
        `Failed to parse RPC worker response: ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const entry of this.pending.values()) {
        entry.reject(parseError);
      }
      this.pending.clear();
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if (!response.ok) {
      pending.reject(new Error(response.error?.message ?? "RPC worker returned an unknown error"));
      return;
    }
    pending.resolve(response.result);
  }
}

export class RpcTaskProcessorPool implements TaskProcessor {
  private cursor = 0;

  constructor(private readonly workers: RpcTaskProcessorClient[]) {
    if (workers.length === 0) {
      throw new Error("RPC task processor pool requires at least one worker");
    }
  }

  async process(task: TaskRecord): Promise<RunResult> {
    const worker = this.workers[this.cursor % this.workers.length]!;
    this.cursor += 1;
    return worker.process(task);
  }

  async cancel(taskId: string): Promise<boolean> {
    const results = await Promise.all(this.workers.map((worker) => worker.cancel(taskId)));
    return results.some(Boolean);
  }

  async dispose(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.dispose()));
  }
}
