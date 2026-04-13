import { stdin, stdout, stderr } from "node:process";
import type { Writable } from "node:stream";

import type { RunResult, TaskRecord } from "../../../packages/agent-contracts/src/index.js";
import type { TaskProcessor } from "./index.js";

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

export class RpcTaskProcessorServer {
  private buffer = "";

  constructor(
    private readonly processor: TaskProcessor,
    private readonly io: {
      input?: NodeJS.ReadableStream;
      output?: Writable;
      errorOutput?: Writable;
    } = {},
  ) {}

  listen(): void {
    const input = this.io.input ?? stdin;
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => {
      this.handleChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        void this.handleLine(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private async handleLine(line: string): Promise<void> {
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch (error) {
      this.writeError(
        `Failed to parse RPC request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    try {
      if (request.method === "process") {
        if (!request.params.task) {
          throw new Error("RPC process request is missing task payload");
        }
        const result = await this.processor.process(request.params.task);
        this.write({
          id: request.id,
          ok: true,
          result,
        } satisfies RpcResponse<RunResult>);
        return;
      }

      if (request.method === "cancel") {
        if (!request.params.taskId) {
          throw new Error("RPC cancel request is missing taskId");
        }
        const result = await this.processor.cancel(request.params.taskId);
        this.write({
          id: request.id,
          ok: true,
          result,
        } satisfies RpcResponse<boolean>);
        return;
      }

      throw new Error(`Unknown RPC method '${request.method}'`);
    } catch (error) {
      this.write({
        id: request.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies RpcResponse);
    }
  }

  private write(message: RpcResponse): void {
    const output = this.io.output ?? stdout;
    output.write(`${JSON.stringify(message)}\n`);
  }

  private writeError(message: string): void {
    const errorOutput = this.io.errorOutput ?? stderr;
    errorOutput.write(`${message}\n`);
  }
}

export function runRpcTaskProcessorServer(processor: TaskProcessor): void {
  new RpcTaskProcessorServer(processor).listen();
}
