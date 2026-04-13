import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import Ajv from "ajv";
import { streamSimpleOpenAIResponses } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  defineTool,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type {
  ArtifactRef,
  CompiledAgentSpec,
  CompletionPolicy,
  PlatformError,
  PlatformRunEvent,
  RunResult,
  SubmitResultPayload,
  TaskRecord,
} from "../../../packages/agent-contracts/src/index.js";
import {
  createPlatformError,
  ensureDir,
  FileSystemCompatibilityMatrix,
  loadPlatformRuntimeConfig,
  nowIso,
  randomId,
  sha256,
} from "../../../packages/agent-platform-shared/src/index.js";

const execFileAsync = promisify(execFile);

export interface AbortGraph {
  root: AbortController;
  session: AbortController;
  tools: AbortController;
  subagents: AbortController;
  ioFlush: AbortController;
}

export function createAbortGraph(): AbortGraph {
  const root = new AbortController();
  const session = new AbortController();
  const tools = new AbortController();
  const subagents = new AbortController();
  const ioFlush = new AbortController();

  root.signal.addEventListener("abort", () => {
    const reason = root.signal.reason;
    session.abort(reason);
    tools.abort(reason);
    subagents.abort(reason);
    ioFlush.abort(reason);
  });

  return { root, session, tools, subagents, ioFlush };
}

export interface RunSettledBarrier {
  markPromptResolved(): void;
  markTerminalEvent(eventType: string): void;
  markBackgroundWorkStarted(name: string): void;
  markBackgroundWorkFinished(name: string): void;
  addFinalizer(check: () => Promise<boolean>): void;
  waitUntilSettled(timeoutMs: number): Promise<void>;
  snapshot(): {
    promptResolved: boolean;
    terminalEventSeen: boolean;
    noPendingBackgroundWork: boolean;
    finalizerPassed: boolean;
  };
}

class DefaultRunSettledBarrier implements RunSettledBarrier {
  private promptResolved = false;
  private terminalEventSeen = false;
  private terminalEventType?: string;
  private readonly pendingBackgroundWork = new Set<string>();
  private finalizerPassed = false;
  private readonly finalizers: Array<() => Promise<boolean>> = [];
  private readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private evaluating = false;

  constructor(private readonly policy: CompletionPolicy) {}

  markPromptResolved(): void {
    this.promptResolved = true;
    void this.evaluate();
  }

  markTerminalEvent(eventType: string): void {
    this.terminalEventSeen = true;
    this.terminalEventType = eventType;
    void this.evaluate();
  }

  markBackgroundWorkStarted(name: string): void {
    this.pendingBackgroundWork.add(name);
  }

  markBackgroundWorkFinished(name: string): void {
    this.pendingBackgroundWork.delete(name);
    void this.evaluate();
  }

  addFinalizer(check: () => Promise<boolean>): void {
    this.finalizers.push(check);
  }

  waitUntilSettled(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Run was not settled within ${timeoutMs}ms (promptResolved=${this.promptResolved}, terminalEventSeen=${this.terminalEventSeen}, pending=${this.pendingBackgroundWork.size}, terminalEventType=${this.terminalEventType ?? "none"})`,
          ),
        );
      }, timeoutMs);

      const waiter = { resolve, reject, timeout };
      this.waiters.add(waiter);
      void this.evaluate();
    });
  }

  snapshot(): {
    promptResolved: boolean;
    terminalEventSeen: boolean;
    noPendingBackgroundWork: boolean;
    finalizerPassed: boolean;
  } {
    return {
      promptResolved: this.promptResolved,
      terminalEventSeen: this.terminalEventSeen,
      noPendingBackgroundWork: this.pendingBackgroundWork.size === 0,
      finalizerPassed: this.finalizerPassed,
    };
  }

  private async evaluate(): Promise<void> {
    if (this.evaluating || this.waiters.size === 0) {
      return;
    }

    if (!this.baseConditionsSatisfied()) {
      return;
    }

    this.evaluating = true;
    try {
      this.finalizerPassed = true;
      for (const finalizer of this.finalizers) {
        const passed = await finalizer();
        if (!passed) {
          this.finalizerPassed = false;
          this.rejectAll(new Error("Run settled preconditions were met, but at least one finalizer failed."));
          return;
        }
      }
      this.resolveAll();
    } finally {
      this.evaluating = false;
    }
  }

  private baseConditionsSatisfied(): boolean {
    if (this.policy.requirePromptResolved && !this.promptResolved) {
      return false;
    }
    if (this.policy.requireTerminalEvent && !this.terminalEventSeen) {
      return false;
    }
    if (this.policy.requireNoPendingWork && this.pendingBackgroundWork.size > 0) {
      return false;
    }
    return true;
  }

  private resolveAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    this.waiters.clear();
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export function createRunSettledBarrier(policy: CompletionPolicy): RunSettledBarrier {
  return new DefaultRunSettledBarrier(policy);
}

export interface WorkspaceLease {
  workspaceId: string;
  path: string;
  cleanup(): Promise<void>;
}

interface ContainerWorkspaceManifest {
  kind: "local-container-workspace";
  taskId: string;
  tenantId: string;
  createdAt: string;
  network: "disabled" | "restricted" | "allowed";
  maxDiskMb: number;
  ttlMinutes: number;
  mounts: Array<{
    logicalName: "input" | "repo" | "output" | "tmp" | "logs";
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
  }>;
}

export class FileSystemWorkspaceManager {
  private readonly absoluteRuntimeRoot: string;

  constructor(private readonly runtimeRoot: string) {
    this.absoluteRuntimeRoot = path.resolve(runtimeRoot);
  }

  async prepare(ctx: {
    taskId: string;
    tenantId: string;
    mode: string;
    contextRefs?: ArtifactRef[];
    retainOnFailure?: boolean;
    sourceRepoPath?: string;
    branchName?: string;
    network?: "disabled" | "restricted" | "allowed";
    maxDiskMb?: number;
    ttlMinutes?: number;
  }): Promise<WorkspaceLease> {
    const workspaceId = randomId("ws");
    const tenantDir = toTenantPathSegment(ctx.tenantId);
    const workspacePath = path.join(this.absoluteRuntimeRoot, "workspaces", tenantDir, workspaceId);
    const inputPath = path.join(workspacePath, "input");
    const repoPath = path.join(workspacePath, "repo");
    const outputPath = path.join(workspacePath, "output");
    const tmpPath = path.join(workspacePath, "tmp");
    const logsPath = path.join(workspacePath, "logs");
    await Promise.all([inputPath, outputPath, tmpPath, logsPath].map((dir) => ensureDir(dir)));

    let createdBranchName: string | undefined;
    if (ctx.mode === "git-worktree") {
      createdBranchName = await this.prepareGitWorktree(repoPath, ctx);
    } else {
      await ensureDir(repoPath);
      if (ctx.mode === "container") {
        await this.prepareContainerRepoSnapshot(repoPath, ctx);
      }
    }

    for (const ref of ctx.contextRefs ?? []) {
      const sourcePath = this.resolveLocalUri(ref.uri);
      if (!sourcePath) {
        continue;
      }
      const targetPath = path.join(inputPath, path.basename(sourcePath));
      await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
    }

    if (ctx.mode === "readonly") {
      await fs.chmod(repoPath, 0o555);
    }

    if (ctx.mode === "container") {
      await this.finalizeContainerWorkspace({
        taskId: ctx.taskId,
        tenantId: ctx.tenantId,
        workspacePath,
        inputPath,
        repoPath,
        outputPath,
        tmpPath,
        logsPath,
        network: ctx.network ?? "disabled",
        maxDiskMb: ctx.maxDiskMb ?? 0,
        ttlMinutes: ctx.ttlMinutes ?? 0,
      });
    }

    return {
      workspaceId,
      path: workspacePath,
      cleanup: async () => {
        if (ctx.retainOnFailure) {
          return;
        }
        if (ctx.mode === "git-worktree" && ctx.sourceRepoPath) {
          // 先把 worktree 从源仓库注册表里移除，再清理目录，避免残留脏引用。
          await removeGitWorktree(ctx.sourceRepoPath, repoPath);
          if (createdBranchName) {
            await deleteGitBranch(ctx.sourceRepoPath, createdBranchName);
          }
        }
        if (ctx.mode === "container" || ctx.mode === "readonly") {
          // 回收前先恢复写权限，避免只读挂载目录导致清理失败。
          await setWritableRecursively(workspacePath);
        }
        await fs.rm(workspacePath, { recursive: true, force: true });
      },
    };
  }

  private resolveLocalUri(uri: string): string | undefined {
    if (uri.startsWith("file://")) {
      return new URL(uri).pathname;
    }
    if (path.isAbsolute(uri)) {
      return uri;
    }
    return undefined;
  }

  private async prepareGitWorktree(
    repoPath: string,
    ctx: {
      taskId: string;
      sourceRepoPath?: string;
      branchName?: string;
    },
  ): Promise<string> {
    if (!ctx.sourceRepoPath) {
      throw createPlatformError({
        stage: "workspace",
        code: "workspace.git_worktree_repo_missing",
        message: `Task '${ctx.taskId}' requires input.metadata.repoPath when workspace mode is git-worktree`,
        retryable: false,
      });
    }

    await ensureDir(path.dirname(repoPath));
    const branchName = ctx.branchName ?? buildWorktreeBranchName(ctx.taskId);
    await execFileAsync(
      "git",
      ["-C", ctx.sourceRepoPath, "worktree", "add", "--detach", repoPath],
      undefined,
    );
    await execFileAsync("git", ["-C", repoPath, "branch", "-f", branchName, "HEAD"], undefined);
    return branchName;
  }

  private async prepareContainerRepoSnapshot(
    repoPath: string,
    ctx: {
      taskId: string;
      sourceRepoPath?: string;
    },
  ): Promise<void> {
    if (!ctx.sourceRepoPath) {
      return;
    }

    try {
      // container 模式先复制一份本地仓库快照，后续再由真实容器运行时消费这份目录。
      await copyDirectoryContents(ctx.sourceRepoPath, repoPath);
    } catch (error) {
      throw createPlatformError({
        stage: "workspace",
        code: "workspace.repo_snapshot_failed",
        message: `Task '${ctx.taskId}' failed to prepare repo snapshot from '${ctx.sourceRepoPath}'`,
        retryable: false,
        details: {
          sourceRepoPath: ctx.sourceRepoPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async finalizeContainerWorkspace(input: {
    taskId: string;
    tenantId: string;
    workspacePath: string;
    inputPath: string;
    repoPath: string;
    outputPath: string;
    tmpPath: string;
    logsPath: string;
    network: "disabled" | "restricted" | "allowed";
    maxDiskMb: number;
    ttlMinutes: number;
  }): Promise<void> {
    // 先把输入目录锁成只读，避免高风险工具把业务输入原件当作临时工作目录。
    await setReadOnlyRecursively(input.inputPath);

    const manifest: ContainerWorkspaceManifest = {
      kind: "local-container-workspace",
      taskId: input.taskId,
      tenantId: input.tenantId,
      createdAt: nowIso(),
      network: input.network,
      maxDiskMb: input.maxDiskMb,
      ttlMinutes: input.ttlMinutes,
      mounts: [
        buildContainerMount("input", input.inputPath, true),
        buildContainerMount("repo", input.repoPath, false),
        buildContainerMount("output", input.outputPath, false),
        buildContainerMount("tmp", input.tmpPath, false),
        buildContainerMount("logs", input.logsPath, false),
      ],
    };

    // 这份清单先作为“本地容器提供者”的契约文件，后续接 OCI runtime 时可直接复用。
    await fs.writeFile(
      path.join(input.workspacePath, "container-manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
}

function buildWorktreeBranchName(taskId: string): string {
  return `pi/${taskId}-${Date.now()}`;
}

function buildContainerMount(
  logicalName: ContainerWorkspaceManifest["mounts"][number]["logicalName"],
  hostPath: string,
  readOnly: boolean,
): ContainerWorkspaceManifest["mounts"][number] {
  return {
    logicalName,
    hostPath,
    containerPath: `/workspace/${logicalName}`,
    readOnly,
  };
}

async function removeGitWorktree(sourceRepoPath: string, repoPath: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", sourceRepoPath, "worktree", "remove", "--force", repoPath], undefined);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }
}

async function deleteGitBranch(sourceRepoPath: string, branchName: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", sourceRepoPath, "branch", "-D", branchName], undefined);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }
}

async function copyDirectoryContents(sourceDir: string, destinationDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      fs.cp(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name), {
        recursive: true,
        force: true,
      }),
    ),
  );
}

async function setReadOnlyRecursively(targetPath: string): Promise<void> {
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    for (const entry of entries) {
      await setReadOnlyRecursively(path.join(targetPath, entry));
    }
    await fs.chmod(targetPath, 0o555);
    return;
  }

  await fs.chmod(targetPath, 0o444);
}

async function setWritableRecursively(targetPath: string): Promise<void> {
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    await fs.chmod(targetPath, 0o755);
    const entries = await fs.readdir(targetPath);
    for (const entry of entries) {
      await setWritableRecursively(path.join(targetPath, entry));
    }
    return;
  }

  await fs.chmod(targetPath, 0o644);
}

export class FileSystemArtifactStore {
  constructor(private readonly runtimeRoot: string) {}

  async put(localPath: string, meta: { taskId: string; runId: string; kind: string }): Promise<ArtifactRef> {
    const artifactId = randomId("artifact");
    const destinationDir = path.join(this.runtimeRoot, "artifacts", meta.taskId, meta.runId);
    await ensureDir(destinationDir);
    const destination = path.join(destinationDir, `${artifactId}-${path.basename(localPath)}`);
    await fs.cp(localPath, destination, { recursive: true, force: true });
    const stat = await fs.stat(destination);

    return {
      artifactId,
      kind: meta.kind,
      uri: destination,
      digest: await this.digestFile(destination),
      title: path.basename(destination),
      sizeBytes: stat.size,
    };
  }

  async putText(
    content: string,
    meta: { taskId: string; runId: string; kind: string; filename: string },
  ): Promise<ArtifactRef> {
    const artifactId = randomId("artifact");
    const destinationDir = path.join(this.runtimeRoot, "artifacts", meta.taskId, meta.runId);
    await ensureDir(destinationDir);
    const destination = path.join(destinationDir, `${artifactId}-${meta.filename}`);
    await fs.writeFile(destination, content, "utf8");
    const stat = await fs.stat(destination);

    return {
      artifactId,
      kind: meta.kind,
      uri: destination,
      digest: `sha256:${sha256(content)}`,
      title: meta.filename,
      sizeBytes: stat.size,
    };
  }

  private async digestFile(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
  }
}

export class FileSystemTraceStore {
  private readonly buffers = new Map<string, PlatformRunEvent[]>();

  constructor(private readonly runtimeRoot: string) {}

  append(runId: string, event: PlatformRunEvent): void {
    const existing = this.buffers.get(runId) ?? [];
    existing.push(event);
    this.buffers.set(runId, existing);
  }

  async flush(runId: string): Promise<string> {
    const traceDir = path.join(this.runtimeRoot, "traces");
    await ensureDir(traceDir);
    const tracePath = path.join(traceDir, `${runId}.jsonl`);
    const buffer = this.buffers.get(runId) ?? [];
    const serialized = buffer.map((event) => JSON.stringify(event)).join("\n");
    await fs.writeFile(tracePath, serialized.length > 0 ? `${serialized}\n` : "", "utf8");
    this.buffers.delete(runId);
    return tracePath;
  }

  async read(runId: string): Promise<string> {
    const tracePath = path.join(this.runtimeRoot, "traces", `${runId}.jsonl`);
    return fs.readFile(tracePath, "utf8");
  }
}

export class DefaultEventTranslator {
  translate(rawEvent: AgentSessionEvent | Record<string, unknown>, ctx: { runId: string; taskId: string; specId: string }): PlatformRunEvent {
    const rawType = typeof rawEvent.type === "string" ? rawEvent.type : "unknown";
    const timestamp = nowIso();

    switch (rawType) {
      case "agent_start":
        return this.base("run.started", rawType, rawEvent, timestamp, ctx);
      case "message_update": {
        const delta =
          (rawEvent as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent?.type ===
          "text_delta"
            ? (rawEvent as { assistantMessageEvent: { delta?: string } }).assistantMessageEvent.delta
            : undefined;
        return {
          ...this.base("run.stream.delta", rawType, rawEvent, timestamp, ctx),
          delta,
        };
      }
      case "tool_execution_start":
        return {
          ...this.base("run.tool.started", rawType, rawEvent, timestamp, ctx),
          toolName: (rawEvent as { toolName?: string }).toolName,
          toolCallId: (rawEvent as { toolCallId?: string }).toolCallId,
        };
      case "tool_execution_end": {
        const event = rawEvent as {
          toolName?: string;
          toolCallId?: string;
          isError?: boolean;
          result?: { details?: { payload?: Record<string, unknown> } };
        };
        if (event.toolName === "submit_result" && !event.isError) {
          return {
            ...this.base("run.protocol.submit_result", rawType, rawEvent, timestamp, ctx),
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            payload: event.result?.details?.payload,
          };
        }
        return {
          ...this.base("run.tool.finished", rawType, rawEvent, timestamp, ctx),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
        };
      }
      case "turn_end":
        return this.base("run.turn.finished", rawType, rawEvent, timestamp, ctx);
      case "agent_end":
        return this.base("run.terminal", rawType, rawEvent, timestamp, ctx);
      case "subagent_start":
      case "subagent_spawn":
      case "subagent_started":
        return {
          ...this.base("run.subagent.started", rawType, rawEvent, timestamp, ctx),
          payload: extractSubagentPayload(rawEvent),
        };
      case "subagent_end":
      case "subagent_complete":
      case "subagent_finished":
        return {
          ...this.base("run.subagent.finished", rawType, rawEvent, timestamp, ctx),
          payload: extractSubagentPayload(rawEvent),
        };
      case "compaction_start":
      case "compaction_end":
        return this.base("run.compaction", rawType, rawEvent, timestamp, ctx);
      case "auto_retry_start":
      case "auto_retry_end":
        return this.base("run.retry", rawType, rawEvent, timestamp, ctx);
      default:
        return this.base("run.unknown", rawType, rawEvent, timestamp, ctx);
    }
  }

  private base(
    type: string,
    rawType: string,
    raw: unknown,
    timestamp: string,
    ctx: { runId: string; taskId: string; specId: string },
  ): PlatformRunEvent {
    return {
      type,
      rawType,
      runId: ctx.runId,
      taskId: ctx.taskId,
      specId: ctx.specId,
      timestamp,
      raw,
    };
  }
}

function extractSubagentPayload(rawEvent: Record<string, unknown>): Record<string, unknown> {
  return {
    subagentId:
      typeof rawEvent.subagentId === "string"
        ? rawEvent.subagentId
        : typeof rawEvent.id === "string"
          ? rawEvent.id
          : undefined,
    role: typeof rawEvent.role === "string" ? rawEvent.role : undefined,
    name: typeof rawEvent.name === "string" ? rawEvent.name : undefined,
  };
}

interface SubmitResultState {
  payload?: SubmitResultPayload;
  callCount: number;
}

function createSubmitResultTool(schema: Record<string, unknown> | undefined, state: SubmitResultState): ToolDefinition {
  const AjvCtor = Ajv as unknown as {
    new (options: { allErrors: boolean; strict: boolean }): {
      compile(value: Record<string, unknown>): ((value: unknown) => boolean) & { errors?: unknown };
    };
  };
  const validator = new AjvCtor({ allErrors: true, strict: false }).compile(schema ?? { type: "object" });

  return defineTool({
    name: "submit_result",
    label: "Submit Result",
    description: "Submit the final structured result for the current task exactly once.",
    promptSnippet: "submit_result: submit the final structured result exactly once before finishing.",
    parameters: Type.Object({
      summary: Type.Optional(Type.String()),
      structured: Type.Optional(Type.Unknown()),
      artifacts: Type.Optional(
        Type.Array(
          Type.Object({
            logicalName: Type.String(),
            path: Type.Optional(Type.String()),
            uri: Type.Optional(Type.String()),
          }),
        ),
      ),
      quality: Type.Optional(
        Type.Object({
          confidence: Type.Optional(Type.Number()),
          incomplete: Type.Optional(Type.Boolean()),
          notes: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      if (state.callCount > 0) {
        throw new Error("submit_result can only be called once.");
      }

      if (!validator(params.structured ?? {})) {
        throw new Error(`submit_result payload does not match output contract schema: ${JSON.stringify(validator.errors)}`);
      }

      state.callCount += 1;
      state.payload = params as SubmitResultPayload;

      return {
        content: [{ type: "text", text: "submit_result accepted." }],
        details: { payload: params },
      };
    },
  });
}

function envKeyForProvider(provider: string): string | undefined {
  const mapping: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    google: "GOOGLE_API_KEY",
    gemini: "GOOGLE_API_KEY",
  };
  return mapping[provider];
}

type InlineExtensionApi = {
  on(event: string, handler: (payload: Record<string, unknown>) => unknown): void;
};

function buildCompactionExtensionFactories(spec: CompiledAgentSpec): Array<(pi: InlineExtensionApi) => void> {
  if (spec.compactionPolicy.mode !== "safeguard") {
    return [];
  }

  return [createSafeguardCompactionExtension(spec)];
}

export function createSafeguardCompactionExtension(spec: CompiledAgentSpec): (pi: InlineExtensionApi) => void {
  const preserveRecentTurns = Math.max(0, spec.compactionPolicy.preserveRecentTurns ?? 0);
  const preserveToolOutputs = spec.compactionPolicy.preserveToolOutputs !== false;

  return (pi) => {
    pi.on("session_before_compact", (event) => {
      const preparation = (event.preparation ?? {}) as Record<string, unknown>;
      const messagesToSummarize = toMessageArray(preparation.messagesToSummarize);
      const turnPrefixMessages = toMessageArray(preparation.turnPrefixMessages);
      const recentTurns = takeRecentTurns([...messagesToSummarize, ...turnPrefixMessages], preserveRecentTurns);
      const protectedToolOutputs = preserveToolOutputs
        ? collectToolOutputs([...recentTurns, ...messagesToSummarize]).slice(-Math.max(1, preserveRecentTurns || 1))
        : [];

      return {
        compaction: {
          summary: buildSafeguardCompactionSummary({
            previousSummary: typeof preparation.previousSummary === "string" ? preparation.previousSummary : undefined,
            fileOps: toFileOps(preparation.fileOps),
            recentTurns,
            protectedToolOutputs,
            olderMessages: messagesToSummarize.filter((message) => !recentTurns.includes(message)),
          }),
          firstKeptEntryId: String(preparation.firstKeptEntryId ?? ""),
          tokensBefore: Number(preparation.tokensBefore ?? 0),
          details: {
            mode: "safeguard",
            preserveRecentTurns,
            preserveToolOutputs,
            summarizeOlderThanTurns: spec.compactionPolicy.summarizeOlderThanTurns ?? 0,
            protectedSections: {
              recentTurnMessages: recentTurns.length,
              toolOutputs: protectedToolOutputs.length,
            },
          },
        },
      };
    });

    pi.on("session_compact", () => {
      // The platform persists compaction events via the event translator.
    });
  };
}

function buildSafeguardCompactionSummary(input: {
  previousSummary?: string;
  fileOps: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  recentTurns: Array<Record<string, unknown>>;
  protectedToolOutputs: Array<Record<string, unknown>>;
  olderMessages: Array<Record<string, unknown>>;
}): string {
  const sections = ["# Safeguard Compaction Summary"];

  if (input.previousSummary) {
    sections.push(["## Prior Summary", input.previousSummary].join("\n"));
  }

  if (input.fileOps.readFiles.length > 0 || input.fileOps.modifiedFiles.length > 0) {
    sections.push(
      [
        "## File Operations",
        ...input.fileOps.readFiles.map((filePath) => `- Read: ${filePath}`),
        ...input.fileOps.modifiedFiles.map((filePath) => `- Modified: ${filePath}`),
      ].join("\n"),
    );
  }

  if (input.recentTurns.length > 0) {
    sections.push(["## Protected Recent Turns", ...summarizeMessages(input.recentTurns)].join("\n"));
  }

  if (input.protectedToolOutputs.length > 0) {
    sections.push(["## Protected Tool Outputs", ...summarizeMessages(input.protectedToolOutputs)].join("\n"));
  }

  if (input.olderMessages.length > 0) {
    sections.push(["## Older Context Summary", ...summarizeMessages(input.olderMessages)].join("\n"));
  }

  return sections.join("\n\n");
}

function takeRecentTurns(messages: Array<Record<string, unknown>>, preserveRecentTurns: number): Array<Record<string, unknown>> {
  if (preserveRecentTurns <= 0 || messages.length === 0) {
    return [];
  }

  const turns: Array<Array<Record<string, unknown>>> = [];
  let currentTurn: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (getMessageRole(message) === "user" && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [message];
      continue;
    }
    currentTurn.push(message);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns.slice(-preserveRecentTurns).flat();
}

function collectToolOutputs(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.filter((message) => getMessageRole(message) === "tool" || typeof message.toolName === "string");
}

function summarizeMessages(messages: Array<Record<string, unknown>>, maxItems = 6): string[] {
  return messages.slice(0, maxItems).map((message) => {
    const role = getMessageRole(message).toUpperCase();
    const toolName = typeof message.toolName === "string" ? ` (${message.toolName})` : "";
    return `- ${role}${toolName}: ${getMessageText(message)}`;
  });
}

function toMessageArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
}

function toFileOps(value: unknown): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  if (!value || typeof value !== "object") {
    return { readFiles: [], modifiedFiles: [] };
  }

  const fileOps = value as Record<string, unknown>;
  return {
    readFiles: Array.isArray(fileOps.readFiles)
      ? fileOps.readFiles.filter((entry): entry is string => typeof entry === "string")
      : [],
    modifiedFiles: Array.isArray(fileOps.modifiedFiles)
      ? fileOps.modifiedFiles.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function getMessageRole(message: Record<string, unknown>): string {
  return typeof message.role === "string" ? message.role : "unknown";
}

function getMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string") {
          return entry.text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  if (typeof message.text === "string") {
    return message.text;
  }

  return "[no text captured]";
}

interface ResolvedModelCandidate {
  provider: string;
  modelId: string;
  model: unknown;
}

type FailureDiagnostic = NonNullable<NonNullable<RunResult["diagnostics"]>["failures"]>[number];

interface SubagentChainStep {
  id: string;
  role?: string;
  name?: string;
  prompt: string;
  dependsOn?: string[];
}

interface SubagentStepResult {
  subagentId: string;
  role?: string;
  name?: string;
  prompt: string;
  text?: string;
  structured?: Record<string, unknown>;
  submissionMode: RunResult["result"] extends undefined
    ? never
    : NonNullable<RunResult["result"]>["submissionMode"];
}

interface CustomResourceOverlay {
  systemPrompt?: string;
  appendSystemPrompts: string[];
  agentsFiles: Array<{
    path: string;
    content: string;
  }>;
  skillRefs: string[];
  extensionRefs: string[];
  promptTemplateRefs: string[];
}

export interface PiRuntimeBundle {
  resourceLoader: ResourceLoader;
  tools: BuiltInTool[];
  customTools: ToolDefinition[];
  model: unknown;
  selectedModel: {
    provider: string;
    model: string;
  };
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  abortGraph: AbortGraph;
  submitResultState: SubmitResultState;
}

class FileSystemCustomResourceLoader implements ResourceLoader {
  constructor(
    private readonly delegate: DefaultResourceLoader,
    readonly viewName: string | undefined,
  ) {}

  getExtensions() {
    return this.delegate.getExtensions();
  }

  getSkills() {
    return this.delegate.getSkills();
  }

  getPrompts() {
    return this.delegate.getPrompts();
  }

  getThemes() {
    return this.delegate.getThemes();
  }

  getAgentsFiles() {
    return this.delegate.getAgentsFiles();
  }

  getSystemPrompt() {
    return this.delegate.getSystemPrompt();
  }

  getAppendSystemPrompt() {
    return this.delegate.getAppendSystemPrompt();
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    this.delegate.extendResources(paths);
  }

  reload(): Promise<void> {
    return this.delegate.reload();
  }
}

export class DefaultPiResourceAssembler {
  private readonly transientSessionManagers = new Map<string, SessionManager>();

  constructor(private readonly runtimeRoot: string) {}

  async assemble(input: {
    spec: CompiledAgentSpec;
    workspacePath: string;
    tenantId: string;
    task: TaskRecord["envelope"];
    preferredModel?: {
      provider: string;
      model: string;
    };
  }): Promise<PiRuntimeBundle> {
    const abortGraph = createAbortGraph();
    const compatibilityMatrix = new FileSystemCompatibilityMatrix(this.runtimeRoot);
    await compatibilityMatrix.initialize([
      {
        sdkVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-14",
      },
    ]);
    if (!(await compatibilityMatrix.isCompatible(input.spec))) {
      throw createPlatformError({
        stage: "platform",
        code: "compatibility.unsupported",
        message: `Spec '${input.spec.specId}' is not supported by the current compatibility matrix`,
        retryable: false,
      });
    }
    await validateExtensionGovernance(input.spec, input.workspacePath);

    const { authStorage, modelRegistry } = await this.createModelRegistry(input.tenantId);
    const resolvedModel = input.preferredModel
      ? resolveSpecificModelFromPolicy(input.spec, modelRegistry, input.preferredModel)
      : resolveModelFromPolicy(input.spec, modelRegistry);

    if (!resolvedModel) {
      throw createPlatformError({
        stage: "model",
        code: "model.not_found",
        message: `Unable to resolve any configured model for spec '${input.spec.specId}'`,
        retryable: false,
      });
    }

    const submitResultState: SubmitResultState = { callCount: 0 };
    const customTools = [createSubmitResultTool(input.spec.outputContract.schema, submitResultState)];

    const resourceLoader = await this.createResourceLoader(input);
    await resourceLoader.reload();

    const settingsManager = SettingsManager.inMemory({
      compaction: {
        enabled: input.spec.compactionPolicy.mode !== "manual-only",
      },
      retry: {
        enabled: input.spec.retryPolicy.maxRetries > 0,
        maxRetries: input.spec.retryPolicy.maxRetries,
      },
    } as never);

    const tools = buildBuiltInTools(input.workspacePath, input.spec.toolPolicy.tools);

    return {
      resourceLoader,
      tools,
      customTools,
      model: resolvedModel.model,
      selectedModel: {
        provider: resolvedModel.provider,
        model: resolvedModel.modelId,
      },
      sessionManager: this.buildSessionManager(input),
      settingsManager,
      authStorage,
      modelRegistry,
      abortGraph,
      submitResultState,
    };
  }

  async resolveModelCandidates(input: {
    spec: CompiledAgentSpec;
    tenantId: string;
  }): Promise<ResolvedModelCandidate[]> {
    const { modelRegistry } = await this.createModelRegistry(input.tenantId);
    return resolveModelCandidatesFromPolicy(input.spec, modelRegistry);
  }

  private async createResourceLoader(input: {
    spec: CompiledAgentSpec;
    workspacePath: string;
    tenantId: string;
    task: TaskRecord["envelope"];
  }): Promise<ResourceLoader> {
    const overlay = await this.loadCustomResourceOverlay(input);
    const mergedExtensionRefs = dedupeStrings([
      ...input.spec.resources.extensionRefs,
      ...(overlay?.extensionRefs ?? []),
    ]);
    const mergedSkillRefs = dedupeStrings([
      ...input.spec.resources.skillRefs,
      ...(overlay?.skillRefs ?? []),
    ]);
    const mergedPromptTemplateRefs = dedupeStrings([
      ...input.spec.resources.promptTemplateRefs,
      ...(overlay?.promptTemplateRefs ?? []),
    ]);
    const mergedAgentsFiles = [
      ...input.spec.prompts.agentsFiles,
      ...(overlay?.agentsFiles ?? []),
    ];
    const mergedAppendSystemPrompts = [
      ...input.spec.prompts.appendSystemPrompts,
      ...(overlay?.appendSystemPrompts ?? []),
    ];
    const loaderCwd = overlay
      ? await this.getIsolatedResourceLoaderCwd(input.tenantId)
      : input.workspacePath;
    const delegate = new DefaultResourceLoader({
      cwd: loaderCwd,
      additionalExtensionPaths: mergedExtensionRefs,
      additionalSkillPaths: mergedSkillRefs,
      additionalPromptTemplatePaths: mergedPromptTemplateRefs,
      extensionFactories: buildCompactionExtensionFactories(input.spec) as never,
      noExtensions:
        mergedExtensionRefs.length === 0 &&
        input.spec.compactionPolicy.mode !== "safeguard" &&
        !input.spec.extensionGovernance.allowWorkspaceDiscovery,
      noSkills: mergedSkillRefs.length === 0,
      noPromptTemplates: mergedPromptTemplateRefs.length === 0,
      agentsFilesOverride: () => ({ agentsFiles: mergedAgentsFiles }),
      systemPromptOverride: input.spec.prompts.preservePiDefaultSystemPrompt
        ? undefined
        : () => overlay?.systemPrompt ?? input.spec.prompts.systemPrompt,
      appendSystemPromptOverride: (base) => [...base, ...mergedAppendSystemPrompts],
    });

    if (!overlay) {
      return delegate;
    }

    return new FileSystemCustomResourceLoader(delegate, readCustomResourceViewName(input.task));
  }

  private async createModelRegistry(tenantId: string): Promise<{
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
  }> {
    const authDir = path.join(this.runtimeRoot, "auth", toTenantPathSegment(tenantId));
    await ensureDir(authDir);
    const runtimeConfig = loadPlatformRuntimeConfig();
    const authStorage = AuthStorage.create(path.join(authDir, "auth.json"));
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    registerRuntimeProviders(modelRegistry, authStorage, runtimeConfig);
    return {
      authStorage,
      modelRegistry,
    };
  }

  private async loadCustomResourceOverlay(input: {
    spec: CompiledAgentSpec;
    workspacePath: string;
    tenantId: string;
    task: TaskRecord["envelope"];
  }): Promise<CustomResourceOverlay | undefined> {
    const metadata = input.task.input.metadata ?? {};
    const viewName = readCustomResourceViewName(input.task);
    const runtimeOverrides = normalizeCustomResourceOverlay(
      metadata.resourceOverrides,
      path.join(this.runtimeRoot, "resource-overrides", toTenantPathSegment(input.tenantId)),
    );

    if (!viewName) {
      return hasCustomOverlay(runtimeOverrides) ? runtimeOverrides : undefined;
    }

    const manifestPath = path.join(
      this.runtimeRoot,
      "resource-views",
      toTenantPathSegment(input.tenantId),
      `${viewName}.json`,
    );
    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(manifestPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw createPlatformError({
          stage: "platform",
          code: "resource_loader.view_not_found",
          message: `Resource view '${viewName}' was not found for tenant '${input.tenantId}'`,
          retryable: false,
        });
      }
      throw error;
    }

    const manifest = normalizeCustomResourceOverlay(
      JSON.parse(manifestContent) as Record<string, unknown>,
      path.dirname(manifestPath),
    );
    const merged = mergeCustomResourceOverlays(manifest, runtimeOverrides);
    return hasCustomOverlay(merged) ? merged : undefined;
  }

  private async getIsolatedResourceLoaderCwd(tenantId: string): Promise<string> {
    const isolatedDir = path.join(this.runtimeRoot, "resource-loader-isolated", toTenantPathSegment(tenantId));
    await ensureDir(isolatedDir);
    return isolatedDir;
  }

  private buildSessionManager(input: {
    spec: CompiledAgentSpec;
    workspacePath: string;
    tenantId: string;
    task: TaskRecord["envelope"];
  }): SessionManager {
    const policy = input.spec.sessionReusePolicy;
    if (policy.mode === "none") {
      return SessionManager.inMemory(input.workspacePath);
    }

    const sessionKey = resolveSessionReuseKey(policy.mode, input.task);
    if (!sessionKey) {
      return SessionManager.inMemory(input.workspacePath);
    }

    if (policy.persistent) {
      // 持久化复用模式下，session 目录按租户与复用键固定，跨 run 也能继续续接。
      const sessionDir = path.join(
        this.runtimeRoot,
        "sessions",
        toTenantPathSegment(input.tenantId),
        sessionKey,
      );
      return SessionManager.continueRecent(input.workspacePath, sessionDir);
    }

    const cacheKey = `${input.tenantId}:${policy.mode}:${sessionKey}`;
    const cached = this.transientSessionManagers.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 非持久化复用模式下，只在当前 worker 进程内复用 SessionManager 实例。
    const created = SessionManager.inMemory(input.workspacePath);
    this.transientSessionManagers.set(cacheKey, created);
    return created;
  }
}

type BuiltInTool =
  | ReturnType<typeof createReadTool>
  | ReturnType<typeof createWriteTool>
  | ReturnType<typeof createBashTool>
  | ReturnType<typeof createEditTool>
  | ReturnType<typeof createGrepTool>
  | ReturnType<typeof createFindTool>
  | ReturnType<typeof createLsTool>;

function buildBuiltInTools(cwd: string, enabledTools: string[]): BuiltInTool[] {
  const toolMap: Record<string, BuiltInTool> = {
    read: createReadTool(cwd),
    write: createWriteTool(cwd),
    bash: createBashTool(cwd),
    edit: createEditTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };

  return enabledTools.flatMap((toolName) => {
    const tool = toolMap[toolName];
    return tool ? [tool] : [];
  });
}

interface SessionLike {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

type SessionFactory = (input: {
  task: TaskRecord;
  spec: CompiledAgentSpec;
  runtime: PiRuntimeBundle;
  workspacePath: string;
}) => Promise<SessionLike>;

const defaultSessionFactory: SessionFactory = async ({ runtime, workspacePath }) => {
  const { session } = await createAgentSession({
    cwd: workspacePath,
    authStorage: runtime.authStorage,
    modelRegistry: runtime.modelRegistry,
    model: runtime.model as never,
    resourceLoader: runtime.resourceLoader,
    tools: runtime.tools,
    customTools: runtime.customTools,
    sessionManager: runtime.sessionManager,
    settingsManager: runtime.settingsManager,
  });

  return session;
};

export class DefaultPiExecutor {
  private readonly activeRuns = new Map<string, AbortGraph>();

  constructor(
    private readonly assembler: DefaultPiResourceAssembler,
    private readonly eventTranslator: DefaultEventTranslator,
    private readonly traceStore: FileSystemTraceStore,
    private readonly artifactStore: FileSystemArtifactStore,
    private readonly sessionFactory: SessionFactory = defaultSessionFactory,
  ) {}

  async execute(ctx: { task: TaskRecord; spec: CompiledAgentSpec; workspacePath: string }): Promise<RunResult> {
    const runId = randomId("run");
    const startedAt = nowIso();
    const deadlineAt = Date.now() + ctx.task.envelope.timeoutMs;
    const candidates = await this.assembler.resolveModelCandidates({
      spec: ctx.spec,
      tenantId: ctx.task.envelope.tenantId,
    });
    const failures: FailureDiagnostic[] = [];
    let retries = 0;
    let failoverAttempts = 0;

    try {
      if (candidates.length === 0) {
        const platformError = createPlatformError({
          stage: "model",
          code: "model.not_found",
          message: `Unable to resolve any configured model for spec '${ctx.spec.specId}'`,
          retryable: false,
        });
        return this.buildFailureResult({
          ctx,
          runId,
          startedAt,
          error: platformError,
          completion: {
            promptResolved: false,
            terminalEventSeen: false,
            noPendingBackgroundWork: true,
            finalizerPassed: false,
          },
          retries,
          failoverAttempts,
          failures: [toFailureDiagnostic(platformError)],
        });
      }

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        if (!candidate) {
          continue;
        }
        const attempt = await this.executeAttempt({
          ctx,
          runId,
          startedAt,
          deadlineAt,
          candidate,
        });
        retries += attempt.retries;

        if (!attempt.result.error) {
          return this.decorateResultDiagnostics(attempt.result, {
            retries,
            failoverAttempts,
            failures,
            candidate,
          });
        }

        const failure = toFailureDiagnostic(attempt.result.error);
        const canFailover = index < candidates.length - 1 && shouldFailoverForError(attempt.rawError, attempt.result.error);
        if (!canFailover) {
          return this.decorateResultDiagnostics(attempt.result, {
            retries,
            failoverAttempts,
            failures: [...failures, failure],
            candidate,
          });
        }

        failures.push(failure);
        failoverAttempts += 1;
        this.traceStore.append(
          runId,
          createFailoverEvent({
            runId,
            taskId: ctx.task.taskId,
            specId: ctx.spec.specId,
            from: candidate,
            to: candidates[index + 1] ?? undefined,
            error: failure,
          }),
        );
      }

      const exhausted = createPlatformError({
        stage: "model",
        code: "provider.failover_exhausted",
        message: `All configured providers failed for spec '${ctx.spec.specId}'`,
        retryable: false,
      });
      return this.buildFailureResult({
        ctx,
        runId,
        startedAt,
        error: exhausted,
        completion: {
          promptResolved: false,
          terminalEventSeen: false,
          noPendingBackgroundWork: true,
          finalizerPassed: false,
        },
        retries,
        failoverAttempts,
        failures: [...failures, toFailureDiagnostic(exhausted)],
      });
    } finally {
      this.activeRuns.delete(ctx.task.taskId);
    }
  }

  async cancel(taskId: string, reason: string): Promise<boolean> {
    const abortGraph = this.activeRuns.get(taskId);
    if (!abortGraph) {
      return false;
    }
    abortGraph.root.abort(
      createPlatformError({
        stage: "platform",
        code: "run.cancelled",
        message: reason,
        retryable: false,
      }),
    );
    return true;
  }

  private async executeAttempt(input: {
    ctx: {
      task: TaskRecord;
      spec: CompiledAgentSpec;
      workspacePath: string;
    };
    runId: string;
    startedAt: string;
    deadlineAt: number;
    candidate: ResolvedModelCandidate;
  }): Promise<{
    result: RunResult;
    rawError?: unknown;
    retries: number;
  }> {
    const settled = createRunSettledBarrier(input.ctx.spec.completionPolicy);
    let finalText = "";
    let retries = 0;
    let compactionCount = 0;
    let runtime: PiRuntimeBundle | undefined;
    let session: SessionLike | undefined;
    let unsubscribe: (() => void) | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const activeSubagentKeys = new Set<string>();
    const anonymousSubagentKeys: string[] = [];
    let anonymousSubagentCounter = 0;
    let subagentResults: SubagentStepResult[] = [];

    try {
      const remainingTimeoutMs = Math.max(1, input.deadlineAt - Date.now());
      runtime = await this.assembler.assemble({
        spec: input.ctx.spec,
        workspacePath: input.ctx.workspacePath,
        tenantId: input.ctx.task.envelope.tenantId,
        task: input.ctx.task.envelope,
        preferredModel: {
          provider: input.candidate.provider,
          model: input.candidate.modelId,
        },
      });
      this.activeRuns.set(input.ctx.task.taskId, runtime.abortGraph);
      subagentResults = await this.executeSubagentChain({
        parentTask: input.ctx.task,
        spec: input.ctx.spec,
        workspacePath: input.ctx.workspacePath,
        runId: input.runId,
        deadlineAt: input.deadlineAt,
        candidate: input.candidate,
        parentAbortGraph: runtime.abortGraph,
      });
      settled.addFinalizer(async () => {
        if (!input.ctx.spec.outputContract.requireSubmitResultTool) {
          return true;
        }
        return Boolean(runtime?.submitResultState.payload);
      });

      session = await this.sessionFactory({
        task: input.ctx.task,
        spec: input.ctx.spec,
        runtime,
        workspacePath: input.ctx.workspacePath,
      });

      runtime.abortGraph.session.signal.addEventListener("abort", () => {
        void session?.abort();
      });
      timeoutHandle = setTimeout(() => {
        runtime?.abortGraph.root.abort(
          createPlatformError({
            stage: "platform",
            code: "run.timeout",
            message: `Task '${input.ctx.task.taskId}' exceeded timeout of ${input.ctx.task.envelope.timeoutMs}ms`,
            retryable: false,
          }),
        );
      }, remainingTimeoutMs);
      const abortPromise = waitForAbort(runtime.abortGraph.root.signal);

      unsubscribe = session.subscribe((rawEvent) => {
        const translated = this.eventTranslator.translate(rawEvent, {
          runId: input.runId,
          taskId: input.ctx.task.taskId,
          specId: input.ctx.spec.specId,
        });
        this.traceStore.append(input.runId, translated);

        if (translated.type === "run.stream.delta" && translated.delta) {
          finalText += translated.delta;
        }
        if (translated.type === "run.retry") {
          retries += 1;
        }
        if (translated.type === "run.compaction") {
          compactionCount += 1;
        }
        if (translated.type === "run.subagent.started") {
          const key = resolveSubagentWorkKeyOnStart(translated, anonymousSubagentCounter++);
          activeSubagentKeys.add(key);
          if (!readSubagentEventId(translated)) {
            anonymousSubagentKeys.push(key);
          }
          settled.markBackgroundWorkStarted(key);
        }
        if (translated.type === "run.subagent.finished") {
          const key = resolveSubagentWorkKeyOnFinish(translated, activeSubagentKeys, anonymousSubagentKeys);
          if (key) {
            activeSubagentKeys.delete(key);
            settled.markBackgroundWorkFinished(key);
          }
        }
        if (translated.type === "run.terminal") {
          settled.markTerminalEvent(translated.rawType);
        }
      });

      const finalPrompt = appendSubagentContextToPrompt(
        input.ctx.task.envelope.input.prompt,
        subagentResults,
      );
      await Promise.race([session.prompt(finalPrompt), abortPromise]);
      settled.markPromptResolved();
      await Promise.race([settled.waitUntilSettled(input.ctx.spec.completionPolicy.settledTimeoutMs), abortPromise]);

      const artifacts = await this.flushArtifacts({
        taskId: input.ctx.task.taskId,
        runId: input.runId,
        workspacePath: input.ctx.workspacePath,
        finalText,
        submitResult: runtime.submitResultState.payload,
        subagentResults,
      });
      const traceArtifact = await this.traceStore.flush(input.runId);
      artifacts.push(
        await this.artifactStore.put(traceArtifact, {
          taskId: input.ctx.task.taskId,
          runId: input.runId,
          kind: "trace",
        }),
      );

      const completion = settled.snapshot();
      const structured = runtime.submitResultState.payload?.structured;
      const status =
        input.ctx.spec.outputContract.requireSubmitResultTool && !runtime.submitResultState.payload
          ? "partial"
          : "succeeded";

      return {
        result: {
          taskId: input.ctx.task.taskId,
          runId: input.runId,
          specId: input.ctx.spec.specId,
          status,
          completion: {
            barrier: "settled-barrier",
            promptResolved: completion.promptResolved,
            terminalEventSeen: completion.terminalEventSeen,
            noPendingBackgroundWork: completion.noPendingBackgroundWork,
            finalizerPassed: completion.finalizerPassed,
          },
          result: {
            text: finalText || runtime.submitResultState.payload?.summary,
            structured,
            submissionMode: runtime.submitResultState.payload ? "submit_result" : "assistant_text",
          },
          artifacts,
          usage: {
            provider: runtime.selectedModel.provider,
            model: runtime.selectedModel.model,
            subagentCount: subagentResults.length,
          },
          compaction: {
            happened: compactionCount > 0,
            count: compactionCount,
            policyMode: input.ctx.spec.compactionPolicy.mode,
          },
          diagnostics: {
            retries,
            failoverAttempts: 0,
          },
          timestamps: {
            startedAt: input.startedAt,
            finishedAt: nowIso(),
          },
        },
        retries,
      };
    } catch (error) {
      const platformError = normalizeExecutorError(error);
      const completion = settled.snapshot();
      const aborted = runtime?.abortGraph.root.signal.aborted ?? false;
      const status = aborted && platformError.code === "run.timeout"
        ? "timed_out"
        : aborted
          ? "cancelled"
          : "failed";

      return {
        result: {
          taskId: input.ctx.task.taskId,
          runId: input.runId,
          specId: input.ctx.spec.specId,
          status,
          completion: {
            barrier: "settled-barrier",
            promptResolved: completion.promptResolved,
            terminalEventSeen: completion.terminalEventSeen,
            noPendingBackgroundWork: completion.noPendingBackgroundWork,
            finalizerPassed: completion.finalizerPassed,
          },
          artifacts: [],
          usage: {
            provider: input.candidate.provider,
            model: input.candidate.modelId,
            subagentCount: subagentResults.length,
          },
          error: platformError,
          diagnostics: {
            retries,
            failoverAttempts: 0,
            failures: [toFailureDiagnostic(platformError)],
          },
          timestamps: {
            startedAt: input.startedAt,
            finishedAt: nowIso(),
          },
        },
        rawError: error,
        retries,
      };
    } finally {
      unsubscribe?.();
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      session?.dispose();
    }
  }

  private async executeSubagentChain(input: {
    parentTask: TaskRecord;
    spec: CompiledAgentSpec;
    workspacePath: string;
    runId: string;
    deadlineAt: number;
    candidate: ResolvedModelCandidate;
    parentAbortGraph: AbortGraph;
  }): Promise<SubagentStepResult[]> {
    const steps = resolveSubagentChainSteps(input.parentTask.envelope);
    if (!steps) {
      return [];
    }

    const mode = readSubagentExecutionMode(input.parentTask.envelope);
    validateSubagentChainPolicy(input.spec, steps, input.parentTask.envelope, mode);
    const childSpec = buildChildSubagentSpec(input.spec);
    if (mode === "dag-lite") {
      const layers = buildSubagentDagLayers(steps);
      const results: SubagentStepResult[] = [];

      for (const layer of layers) {
        if (layer.length > input.spec.subagentPolicy.maxParallel) {
          throw createPlatformError({
            stage: "subagent",
            code: "subagent.parallel_limit_exceeded",
            message: `DAG layer requires ${layer.length} concurrent subagents, exceeding maxParallel=${input.spec.subagentPolicy.maxParallel}`,
            retryable: false,
          });
        }

        const layerResults = await Promise.all(
          layer.map((step, index) =>
            this.executeSubagentEntry({
              parentTask: input.parentTask,
              runId: input.runId,
              spec: input.spec,
              childSpec,
              workspacePath: input.workspacePath,
              deadlineAt: input.deadlineAt,
              candidate: input.candidate,
              parentAbortGraph: input.parentAbortGraph,
              step,
              index,
              mode,
            }),
          ),
        );
        results.push(...layerResults);
      }

      return results;
    }

    if (mode === "parallel") {
      return Promise.all(
        steps.map((step, index) =>
          this.executeSubagentEntry({
            parentTask: input.parentTask,
            runId: input.runId,
            spec: input.spec,
            childSpec,
            workspacePath: input.workspacePath,
            deadlineAt: input.deadlineAt,
            candidate: input.candidate,
            parentAbortGraph: input.parentAbortGraph,
            step,
            index,
            mode,
          }),
        ),
      );
    }

    const results: SubagentStepResult[] = [];
    for (const [index, step] of steps.entries()) {
      results.push(
        await this.executeSubagentEntry({
          parentTask: input.parentTask,
          runId: input.runId,
          spec: input.spec,
          childSpec,
          workspacePath: input.workspacePath,
          deadlineAt: input.deadlineAt,
          candidate: input.candidate,
          parentAbortGraph: input.parentAbortGraph,
          step,
          index,
          mode,
        }),
      );
    }

    return results;
  }

  private async executeSubagentEntry(input: {
    parentTask: TaskRecord;
    runId: string;
    spec: CompiledAgentSpec;
    childSpec: CompiledAgentSpec;
    workspacePath: string;
    deadlineAt: number;
    candidate: ResolvedModelCandidate;
    parentAbortGraph: AbortGraph;
    step: SubagentChainStep;
    index: number;
    mode: "chain" | "parallel" | "dag-lite";
  }): Promise<SubagentStepResult> {
    const subagentId = input.step.id || `subagent-${input.index + 1}`;
    // 父 run 只记录聚合过的生命周期事件，避免把每个子步骤的原始事件噪声全部灌进主 trace。
    this.traceStore.append(
      input.runId,
      createSubagentLifecycleEvent({
        type: "run.subagent.started",
        rawType: `platform.subagent.${input.mode}.start`,
        runId: input.runId,
        taskId: input.parentTask.taskId,
        specId: input.spec.specId,
        payload: {
          subagentId,
          role: input.step.role,
          name: input.step.name,
          index: input.index,
        },
      }),
    );

    try {
      const result = await this.executeSubagentStep({
        parentTask: input.parentTask,
        step: {
          ...input.step,
          id: subagentId,
        },
        spec: input.childSpec,
        workspacePath: input.workspacePath,
        deadlineAt: input.deadlineAt,
        candidate: input.candidate,
        parentAbortGraph: input.parentAbortGraph,
      });
      // 子步骤完成后，把摘要压回父 run trace，供审计与后续父 prompt 汇总使用。
      this.traceStore.append(
        input.runId,
        createSubagentLifecycleEvent({
          type: "run.subagent.finished",
          rawType: `platform.subagent.${input.mode}.finish`,
          runId: input.runId,
          taskId: input.parentTask.taskId,
          specId: input.spec.specId,
          payload: {
            subagentId: result.subagentId,
            role: result.role,
            name: result.name,
            index: input.index,
            submissionMode: result.submissionMode,
            text: result.text,
          },
        }),
      );
      return result;
    } catch (error) {
      throw normalizeSubagentStepError(error, {
        parentTaskId: input.parentTask.taskId,
        subagentId,
      });
    }
  }

  private async executeSubagentStep(input: {
    parentTask: TaskRecord;
    step: SubagentChainStep;
    spec: CompiledAgentSpec;
    workspacePath: string;
    deadlineAt: number;
    candidate: ResolvedModelCandidate;
    parentAbortGraph: AbortGraph;
  }): Promise<SubagentStepResult> {
    const settled = createRunSettledBarrier(input.spec.completionPolicy);
    let finalText = "";
    let runtime: PiRuntimeBundle | undefined;
    let session: SessionLike | undefined;
    let unsubscribe: (() => void) | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const childTask = buildChildSubagentTask({
        parentTask: input.parentTask,
        step: input.step,
      });
      runtime = await this.assembler.assemble({
        spec: input.spec,
        workspacePath: input.workspacePath,
        tenantId: childTask.envelope.tenantId,
        task: childTask.envelope,
        preferredModel: {
          provider: input.candidate.provider,
          model: input.candidate.modelId,
        },
      });
      session = await this.sessionFactory({
        task: childTask,
        spec: input.spec,
        runtime,
        workspacePath: input.workspacePath,
      });

      runtime.abortGraph.session.signal.addEventListener("abort", () => {
        void session?.abort();
      });
      input.parentAbortGraph.subagents.signal.addEventListener("abort", () => {
        runtime?.abortGraph.root.abort(input.parentAbortGraph.subagents.signal.reason);
      });

      timeoutHandle = setTimeout(() => {
        runtime?.abortGraph.root.abort(
          createPlatformError({
            stage: "subagent",
            code: "subagent.timeout",
            message: `Subagent '${input.step.id}' exceeded the remaining parent deadline`,
            retryable: false,
          }),
        );
      }, Math.max(1, input.deadlineAt - Date.now()));

      const abortPromise = Promise.race([
        waitForAbort(runtime.abortGraph.root.signal),
        waitForAbort(input.parentAbortGraph.subagents.signal),
      ]);

      unsubscribe = session.subscribe((rawEvent) => {
        const translated = this.eventTranslator.translate(rawEvent, {
          runId: input.parentTask.taskId,
          taskId: input.parentTask.taskId,
          specId: input.spec.specId,
        });

        if (translated.type === "run.stream.delta" && translated.delta) {
          finalText += translated.delta;
        }
        if (translated.type === "run.terminal") {
          settled.markTerminalEvent(translated.rawType);
        }
      });

      await Promise.race([session.prompt(input.step.prompt), abortPromise]);
      settled.markPromptResolved();
      await Promise.race([settled.waitUntilSettled(input.spec.completionPolicy.settledTimeoutMs), abortPromise]);

      return {
        subagentId: input.step.id,
        role: input.step.role,
        name: input.step.name,
        prompt: input.step.prompt,
        text: finalText,
        submissionMode: "assistant_text",
      };
    } finally {
      unsubscribe?.();
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      session?.dispose();
    }
  }

  private decorateResultDiagnostics(
    result: RunResult,
    input: {
      retries: number;
      failoverAttempts: number;
      failures: FailureDiagnostic[];
      candidate: ResolvedModelCandidate;
    },
  ): RunResult {
    return {
      ...result,
      usage: {
        ...result.usage,
        provider: input.candidate.provider,
        model: input.candidate.modelId,
      },
      diagnostics: {
        ...result.diagnostics,
        retries: input.retries,
        failoverAttempts: input.failoverAttempts,
        failures: input.failures.length > 0 ? input.failures : result.diagnostics?.failures,
      },
    };
  }

  private buildFailureResult(input: {
    ctx: {
      task: TaskRecord;
      spec: CompiledAgentSpec;
    };
    runId: string;
    startedAt: string;
    error: PlatformError;
    completion: Omit<RunResult["completion"], "barrier">;
    retries: number;
    failoverAttempts: number;
    failures: FailureDiagnostic[];
  }): RunResult {
    return {
      taskId: input.ctx.task.taskId,
      runId: input.runId,
      specId: input.ctx.spec.specId,
      status: "failed",
      completion: {
        barrier: "settled-barrier",
        promptResolved: input.completion.promptResolved,
        terminalEventSeen: input.completion.terminalEventSeen,
        noPendingBackgroundWork: input.completion.noPendingBackgroundWork,
        finalizerPassed: input.completion.finalizerPassed,
      },
      artifacts: [],
      error: input.error,
      diagnostics: {
        retries: input.retries,
        failoverAttempts: input.failoverAttempts,
        failures: input.failures,
      },
      timestamps: {
        startedAt: input.startedAt,
        finishedAt: nowIso(),
      },
    };
  }

  private async flushArtifacts(input: {
    taskId: string;
    runId: string;
    workspacePath: string;
    finalText: string;
    submitResult?: SubmitResultPayload;
    subagentResults?: SubagentStepResult[];
  }): Promise<ArtifactRef[]> {
    const artifacts: ArtifactRef[] = [];

    if (input.finalText) {
      artifacts.push(
        await this.artifactStore.putText(input.finalText, {
          taskId: input.taskId,
          runId: input.runId,
          kind: "final-text",
          filename: "final.md",
        }),
      );
    }

    if (input.submitResult) {
      artifacts.push(
        await this.artifactStore.putText(JSON.stringify(input.submitResult, null, 2), {
          taskId: input.taskId,
          runId: input.runId,
          kind: "structured-result",
          filename: "result.json",
        }),
      );
    }

    if (input.subagentResults && input.subagentResults.length > 0) {
      artifacts.push(
        await this.artifactStore.putText(JSON.stringify(input.subagentResults, null, 2), {
          taskId: input.taskId,
          runId: input.runId,
          kind: "subagent-summary",
          filename: "subagents.json",
        }),
      );
    }

    const outputDir = path.join(input.workspacePath, "output");
    const logDir = path.join(input.workspacePath, "logs");
    for (const directory of [outputDir, logDir]) {
      const files = await listFiles(directory);
      for (const filePath of files) {
        artifacts.push(
          await this.artifactStore.put(filePath, {
            taskId: input.taskId,
            runId: input.runId,
            kind: path.basename(directory),
          }),
        );
      }
    }

    return artifacts;
  }
}

async function listFiles(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
          return listFiles(absolutePath);
        }
        return [absolutePath];
      }),
    );
    return files.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function resolveSubagentChainSteps(task: TaskRecord["envelope"]): SubagentChainStep[] | undefined {
  const rawChain = task.input.metadata?.subagentChain;
  if (!Array.isArray(rawChain) || rawChain.length === 0) {
    return undefined;
  }

  return rawChain.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw createPlatformError({
        stage: "subagent",
        code: "subagent.invalid_plan",
        message: `Subagent chain step #${index + 1} must be an object`,
        retryable: false,
      });
    }

    const prompt = (item as Record<string, unknown>).prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw createPlatformError({
        stage: "subagent",
        code: "subagent.invalid_plan",
        message: `Subagent chain step #${index + 1} must provide a non-empty prompt`,
        retryable: false,
      });
    }

    const id = (item as Record<string, unknown>).id;
    const role = (item as Record<string, unknown>).role;
    const name = (item as Record<string, unknown>).name;
    const dependsOn = (item as Record<string, unknown>).dependsOn;

    return {
      id: typeof id === "string" && id.trim().length > 0 ? id : `subagent-${index + 1}`,
      role: typeof role === "string" ? role : undefined,
      name: typeof name === "string" ? name : undefined,
      prompt: prompt.trim(),
      dependsOn: normalizeStringArray(dependsOn),
    };
  });
}

function readCustomResourceViewName(task: TaskRecord["envelope"]): string | undefined {
  const metadata = task.input.metadata ?? {};
  const direct = metadata.resourceView;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  if (
    direct &&
    typeof direct === "object" &&
    "name" in direct &&
    typeof (direct as Record<string, unknown>).name === "string"
  ) {
    const name = (direct as Record<string, unknown>).name as string;
    return name.trim().length > 0 ? name.trim() : undefined;
  }

  const alias = metadata.resourceViewName;
  return typeof alias === "string" && alias.trim().length > 0 ? alias.trim() : undefined;
}

function normalizeCustomResourceOverlay(
  raw: unknown,
  baseDir: string,
): CustomResourceOverlay {
  if (!raw || typeof raw !== "object") {
    return emptyCustomResourceOverlay();
  }

  const value = raw as Record<string, unknown>;
  return {
    systemPrompt: typeof value.systemPrompt === "string" ? value.systemPrompt : undefined,
    appendSystemPrompts: normalizeStringArray(value.appendSystemPrompts),
    agentsFiles: normalizeAgentsFiles(value.agentsFiles),
    skillRefs: normalizePathArray(value.skillRefs, baseDir),
    extensionRefs: normalizePathArray(value.extensionRefs, baseDir),
    promptTemplateRefs: normalizePathArray(value.promptTemplateRefs, baseDir),
  };
}

function emptyCustomResourceOverlay(): CustomResourceOverlay {
  return {
    systemPrompt: undefined,
    appendSystemPrompts: [],
    agentsFiles: [],
    skillRefs: [],
    extensionRefs: [],
    promptTemplateRefs: [],
  };
}

function mergeCustomResourceOverlays(
  base: CustomResourceOverlay,
  override: CustomResourceOverlay,
): CustomResourceOverlay {
  return {
    systemPrompt: override.systemPrompt ?? base.systemPrompt,
    appendSystemPrompts: [...base.appendSystemPrompts, ...override.appendSystemPrompts],
    agentsFiles: [...base.agentsFiles, ...override.agentsFiles],
    skillRefs: dedupeStrings([...base.skillRefs, ...override.skillRefs]),
    extensionRefs: dedupeStrings([...base.extensionRefs, ...override.extensionRefs]),
    promptTemplateRefs: dedupeStrings([...base.promptTemplateRefs, ...override.promptTemplateRefs]),
  };
}

function hasCustomOverlay(overlay: CustomResourceOverlay): boolean {
  return Boolean(
    overlay.systemPrompt ||
      overlay.appendSystemPrompts.length > 0 ||
      overlay.agentsFiles.length > 0 ||
      overlay.skillRefs.length > 0 ||
      overlay.extensionRefs.length > 0 ||
      overlay.promptTemplateRefs.length > 0,
  );
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function normalizeAgentsFiles(
  raw: unknown,
): Array<{
  path: string;
  content: string;
}> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const pathValue = (entry as Record<string, unknown>).path;
    const contentValue = (entry as Record<string, unknown>).content;
    if (typeof pathValue !== "string" || typeof contentValue !== "string") {
      return [];
    }

    return [
      {
        path: pathValue,
        content: contentValue,
      },
    ];
  });
}

function normalizePathArray(raw: unknown, baseDir: string): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return [];
    }
    return [path.isAbsolute(entry) ? entry : path.resolve(baseDir, entry)];
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function buildSubagentDagLayers(steps: SubagentChainStep[]): SubagentChainStep[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn?.length ?? 0);
    for (const dependency of step.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw createPlatformError({
          stage: "subagent",
          code: "subagent.invalid_plan",
          message: `Subagent '${step.id}' depends on unknown node '${dependency}'`,
          retryable: false,
        });
      }

      const existing = dependents.get(dependency) ?? [];
      existing.push(step.id);
      dependents.set(dependency, existing);
    }
  }

  const layers: SubagentChainStep[][] = [];
  let ready = steps.filter((step) => (inDegree.get(step.id) ?? 0) === 0);
  let processed = 0;

  while (ready.length > 0) {
    layers.push(ready);
    processed += ready.length;

    const nextIds = new Set<string>();
    for (const step of ready) {
      for (const dependentId of dependents.get(step.id) ?? []) {
        const remaining = (inDegree.get(dependentId) ?? 0) - 1;
        inDegree.set(dependentId, remaining);
        if (remaining === 0) {
          nextIds.add(dependentId);
        }
      }
    }

    ready = steps.filter((step) => nextIds.has(step.id));
  }

  if (processed !== steps.length) {
    throw createPlatformError({
      stage: "subagent",
      code: "subagent.cycle_detected",
      message: "Subagent DAG contains a cycle and cannot be scheduled",
      retryable: false,
    });
  }

  return layers;
}

function validateSubagentChainPolicy(
  spec: CompiledAgentSpec,
  steps: SubagentChainStep[],
  task: TaskRecord["envelope"],
  mode: "chain" | "parallel" | "dag-lite",
): void {
  if (!spec.subagentPolicy.enabled) {
    throw createPlatformError({
      stage: "subagent",
      code: "subagent.disabled",
      message: `Spec '${spec.specId}' does not allow subagent execution for task '${task.taskId}'`,
      retryable: false,
    });
  }

  if (steps.length > spec.subagentPolicy.maxBreadth) {
    throw createPlatformError({
      stage: "subagent",
      code: "subagent.breadth_exceeded",
      message: `Task '${task.taskId}' requested ${steps.length} subagents, exceeding maxBreadth=${spec.subagentPolicy.maxBreadth}`,
      retryable: false,
    });
  }

  if (mode === "parallel" && steps.length > spec.subagentPolicy.maxParallel) {
    throw createPlatformError({
      stage: "subagent",
      code: "subagent.parallel_limit_exceeded",
      message: `Task '${task.taskId}' requested ${steps.length} parallel subagents, exceeding maxParallel=${spec.subagentPolicy.maxParallel}`,
      retryable: false,
    });
  }

  const currentDepth = readSubagentDepth(task);
  if (currentDepth >= spec.subagentPolicy.maxDepth) {
    throw createPlatformError({
      stage: "subagent",
      code: "subagent.max_depth_exceeded",
      message: `Task '${task.taskId}' cannot spawn subagents beyond maxDepth=${spec.subagentPolicy.maxDepth}`,
      retryable: false,
    });
  }
}

function buildChildSubagentSpec(spec: CompiledAgentSpec): CompiledAgentSpec {
  return {
    ...spec,
    // 子步骤先走“轻量分析助手”语义：允许直接返回文本，不强制 submit_result。
    outputContract: {
      mode: "text",
      requireSubmitResultTool: false,
      textFallbackAllowed: true,
    },
    subagentPolicy: {
      ...spec.subagentPolicy,
      enabled: false,
    },
    completionPolicy: {
      ...spec.completionPolicy,
      requireSubmitResult: false,
    },
  };
}

function buildChildSubagentTask(input: {
  parentTask: TaskRecord;
  step: SubagentChainStep;
}): TaskRecord {
  const parentMetadata = input.parentTask.envelope.input.metadata ?? {};
  const nextMetadata = {
    ...parentMetadata,
    subagentId: input.step.id,
    subagentRole: input.step.role,
    subagentName: input.step.name,
    subagentDepth: readSubagentDepth(input.parentTask.envelope) + 1,
  };
  delete (nextMetadata as Record<string, unknown>).subagentChain;

  return {
    taskId: `${input.parentTask.taskId}::${input.step.id}`,
    idempotencyFingerprint: `${input.parentTask.idempotencyFingerprint}:${input.step.id}`,
    envelope: {
      ...input.parentTask.envelope,
      taskId: `${input.parentTask.taskId}::${input.step.id}`,
      runRequestId: `${input.parentTask.envelope.runRequestId}:${input.step.id}`,
      idempotencyKey: `${input.parentTask.envelope.idempotencyKey}:${input.step.id}`,
      input: {
        ...input.parentTask.envelope.input,
        prompt: input.step.prompt,
        metadata: nextMetadata,
      },
      trace: {
        ...input.parentTask.envelope.trace,
        parentTaskId: input.parentTask.taskId,
      },
    },
    compiledSpec: input.parentTask.compiledSpec,
    status: "RUNNING",
    artifacts: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function readSubagentDepth(task: TaskRecord["envelope"]): number {
  const rawDepth = task.input.metadata?.subagentDepth;
  if (typeof rawDepth === "number" && Number.isFinite(rawDepth) && rawDepth >= 0) {
    return rawDepth;
  }
  if (typeof rawDepth === "string" && /^\d+$/.test(rawDepth)) {
    return Number(rawDepth);
  }
  return 0;
}

function readSubagentExecutionMode(task: TaskRecord["envelope"]): "chain" | "parallel" | "dag-lite" {
  const rawMode = task.input.metadata?.subagentMode;
  if (rawMode === "parallel") {
    return "parallel";
  }
  if (rawMode === "dag-lite") {
    return "dag-lite";
  }
  return "chain";
}

function appendSubagentContextToPrompt(prompt: string, results: SubagentStepResult[]): string {
  if (results.length === 0) {
    return prompt;
  }

  // 最小实现先把 chain 摘要回灌到父 prompt，后续再扩成更正式的 planner/worker/reviewer 协议。
  const context = results
    .map((result, index) =>
      [
        `## 子步骤 ${index + 1}`,
        `id: ${result.subagentId}`,
        result.role ? `role: ${result.role}` : undefined,
        result.name ? `name: ${result.name}` : undefined,
        `prompt: ${result.prompt}`,
        `summary: ${result.text ?? "[no text captured]"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  return `${prompt}\n\n# Subagent Chain Context\n${context}`;
}

function createSubagentLifecycleEvent(input: {
  type: "run.subagent.started" | "run.subagent.finished";
  rawType: string;
  runId: string;
  taskId: string;
  specId: string;
  payload: Record<string, unknown>;
}): PlatformRunEvent {
  return {
    type: input.type,
    rawType: input.rawType,
    runId: input.runId,
    taskId: input.taskId,
    specId: input.specId,
    timestamp: nowIso(),
    payload: input.payload,
    raw: input.payload,
  };
}

function normalizeSubagentStepError(
  error: unknown,
  input: {
    parentTaskId: string;
    subagentId: string;
  },
): PlatformError {
  if (isPlatformError(error) && error.stage === "subagent") {
    return error;
  }

  const normalized = normalizeExecutorError(error);
  return createPlatformError({
    stage: "subagent",
    code: normalized.code === "run.timeout" ? "subagent.timeout" : "subagent.step_failed",
    message: `Subagent '${input.subagentId}' failed while handling parent task '${input.parentTaskId}': ${normalized.message}`,
    retryable: normalized.retryable,
    details: {
      subagentId: input.subagentId,
      causeStage: normalized.stage,
      causeCode: normalized.code,
    },
  });
}

function toFailureDiagnostic(error: PlatformError): FailureDiagnostic {
  return {
    stage: error.stage,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function createFailoverEvent(input: {
  runId: string;
  taskId: string;
  specId: string;
  from: ResolvedModelCandidate;
  to?: ResolvedModelCandidate;
  error: FailureDiagnostic;
}): PlatformRunEvent {
  return {
    type: "run.failover",
    rawType: "platform.failover",
    runId: input.runId,
    taskId: input.taskId,
    specId: input.specId,
    timestamp: nowIso(),
    raw: {
      from: {
        provider: input.from.provider,
        model: input.from.modelId,
      },
      to: input.to
        ? {
            provider: input.to.provider,
            model: input.to.modelId,
          }
        : undefined,
      error: input.error,
    },
  };
}

function normalizeExecutorError(error: unknown): PlatformError {
  if (isPlatformError(error)) {
    return error;
  }

  if (isTransientProviderError(error)) {
    return createPlatformError({
      stage: "model",
      code: "provider.transient_failure",
      message: extractErrorMessage(error),
      retryable: true,
    });
  }

  const message = extractErrorMessage(error);
  return createPlatformError({
    stage: "platform",
    code: "run.unhandled_error",
    message,
    retryable: false,
  });
}

function isPlatformError(error: unknown): error is PlatformError {
  return Boolean(
    error &&
      typeof error === "object" &&
      "stage" in error &&
      "code" in error &&
      "message" in error &&
      "retryable" in error,
  );
}

function shouldFailoverForError(error: unknown, normalized: PlatformError): boolean {
  if (!normalized.retryable) {
    return false;
  }
  if (normalized.code === "run.timeout" || normalized.code === "run.cancelled") {
    return false;
  }
  if (normalized.stage === "model") {
    return true;
  }
  return isTransientProviderError(error);
}

function isTransientProviderError(error: unknown): boolean {
  if (isPlatformError(error)) {
    return error.stage === "model" && error.retryable;
  }

  const status = extractNumericErrorField(error, ["status", "statusCode", "code"]);
  if (status !== undefined && [408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = extractStringErrorField(error, ["code", "errorCode"]);
  if (code && ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ETIMEDOUT"].includes(code)) {
    return true;
  }

  const message = extractErrorMessage(error).toLowerCase();
  return [
    "rate limit",
    "429",
    "overloaded",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "connection reset",
    "network error",
    "upstream",
  ].some((fragment) => message.includes(fragment));
}

function extractNumericErrorField(error: unknown, fields: string[]): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  for (const field of fields) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }

  return undefined;
}

function extractStringErrorField(error: unknown, fields: string[]): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  for (const field of fields) {
    const value = (error as Record<string, unknown>)[field];
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown executor error";
}

function resolveSubagentWorkKeyOnStart(event: PlatformRunEvent, anonymousIndex: number): string {
  const id = readSubagentEventId(event);
  if (id) {
    return `subagent:${id}`;
  }
  return `subagent:anonymous:${anonymousIndex}`;
}

function resolveSubagentWorkKeyOnFinish(
  event: PlatformRunEvent,
  activeKeys: Set<string>,
  anonymousKeys: string[],
): string | undefined {
  const id = readSubagentEventId(event);
  if (id) {
    const key = `subagent:${id}`;
    return activeKeys.has(key) ? key : undefined;
  }

  return anonymousKeys.shift();
}

function readSubagentEventId(event: PlatformRunEvent): string | undefined {
  if (!event.payload) {
    return undefined;
  }

  const candidate = event.payload.subagentId ?? event.payload.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export interface TaskProcessor {
  process(task: TaskRecord): Promise<RunResult>;
  cancel(taskId: string): Promise<boolean>;
}

export class DefaultTaskProcessor implements TaskProcessor {
  constructor(
    private readonly workspaceManager: FileSystemWorkspaceManager,
    private readonly executor: DefaultPiExecutor,
  ) {}

  async process(task: TaskRecord): Promise<RunResult> {
    const metadata = task.envelope.input.metadata ?? {};
    const workspace = await this.workspaceManager.prepare({
      taskId: task.taskId,
      tenantId: task.envelope.tenantId,
      mode: task.compiledSpec.workspacePolicy.mode,
      contextRefs: task.envelope.input.contextRefs,
      retainOnFailure: task.compiledSpec.workspacePolicy.retainOnFailure,
      sourceRepoPath: typeof metadata.repoPath === "string" ? metadata.repoPath : undefined,
      branchName: typeof metadata.branchName === "string" ? metadata.branchName : undefined,
      network: task.compiledSpec.workspacePolicy.network,
      maxDiskMb: task.compiledSpec.workspacePolicy.maxDiskMb,
      ttlMinutes: task.compiledSpec.workspacePolicy.ttlMinutes,
    });

    try {
      return await this.executor.execute({
        task,
        spec: task.compiledSpec,
        workspacePath: workspace.path,
      });
    } finally {
      if (!task.compiledSpec.workspacePolicy.retainOnFailure) {
        await workspace.cleanup();
      }
    }
  }

  cancel(taskId: string): Promise<boolean> {
    return this.executor.cancel(taskId, "Cancelled via control plane.");
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function registerRuntimeProviders(
  modelRegistry: ModelRegistry,
  authStorage: AuthStorage,
  runtimeConfig: ReturnType<typeof loadPlatformRuntimeConfig>,
): void {
  const rightCodes = runtimeConfig.providers.rightCodes;
  if (!rightCodes.enabled) {
    return;
  }

  const runtimeKey = process.env[rightCodes.apiKeyEnvVar];
  if (runtimeKey) {
    authStorage.setRuntimeApiKey(rightCodes.providerName, runtimeKey);
  }

  modelRegistry.registerProvider(rightCodes.providerName, {
    baseUrl: rightCodes.baseUrl,
    apiKey: rightCodes.apiKeyEnvVar,
    api: rightCodes.api,
    authHeader: true,
    streamSimple: streamSimpleOpenAIResponses as never,
    models: [
      {
        id: rightCodes.modelId,
        name: "Right Codes Codex",
        api: rightCodes.api,
        reasoning: true,
        input: ["text", "image"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
}

function resolveModelFromPolicy(
  spec: CompiledAgentSpec,
  modelRegistry: ModelRegistry,
): ResolvedModelCandidate | undefined {
  return resolveModelCandidatesFromPolicy(spec, modelRegistry)[0];
}

function resolveSpecificModelFromPolicy(
  spec: CompiledAgentSpec,
  modelRegistry: ModelRegistry,
  candidate: {
    provider: string;
    model: string;
  },
): ResolvedModelCandidate | undefined {
  return resolveModelCandidatesFromPolicy(spec, modelRegistry).find(
    (resolved) => resolved.provider === candidate.provider && resolved.modelId === candidate.model,
  );
}

function resolveModelCandidatesFromPolicy(
  spec: CompiledAgentSpec,
  modelRegistry: ModelRegistry,
): ResolvedModelCandidate[] {
  const candidates =
    spec.modelPolicy.failoverOrder && spec.modelPolicy.failoverOrder.length > 0
      ? spec.modelPolicy.failoverOrder
      : spec.modelPolicy.providerAllowlist.flatMap((provider) =>
          (spec.modelPolicy.modelAllowlist ?? []).map((model) => ({ provider, model })),
        );
  const resolved: ResolvedModelCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.model) {
      continue;
    }

    const model = modelRegistry.find(candidate.provider, candidate.model);
    if (model) {
      const key = `${candidate.provider}:${candidate.model}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push({
        provider: candidate.provider,
        modelId: candidate.model,
        model,
      });
    }
  }

  return resolved;
}

async function validateExtensionGovernance(spec: CompiledAgentSpec, workspacePath: string): Promise<void> {
  const policy = spec.extensionGovernance;
  if (!policy.allowWorkspaceDiscovery) {
    for (const ref of spec.resources.extensionRefs) {
      if (ref.startsWith(workspacePath)) {
        throw createPlatformError({
          stage: "platform",
          code: "extension.workspace_discovery_blocked",
          message: `Workspace extension ref '${ref}' is blocked by governance policy`,
          retryable: false,
        });
      }
    }
  }

  if (policy.allowedExtensionRefs.length > 0) {
    for (const ref of spec.resources.extensionRefs) {
      if (!policy.allowedExtensionRefs.includes(ref)) {
        throw createPlatformError({
          stage: "platform",
          code: "extension.not_allowed",
          message: `Extension ref '${ref}' is not allowlisted`,
          retryable: false,
        });
      }
    }
  }

  if (policy.hashPinned) {
    await verifyExtensionHashes(spec);
  }
}

async function verifyExtensionHashes(spec: CompiledAgentSpec): Promise<void> {
  for (const ref of spec.resources.extensionRefs) {
    const expectedDigest = spec.resources.extensionDigests[ref];
    if (!expectedDigest) {
      continue;
    }

    // 运行时再次校验扩展内容，防止 spec 编译后文件被偷偷替换。
    const actualDigest = await readFileDigest(ref);
    if (actualDigest !== expectedDigest) {
      throw createPlatformError({
        stage: "platform",
        code: "extension.hash_mismatch",
        message: `Extension ref '${ref}' no longer matches the pinned digest in spec '${spec.specId}'`,
        retryable: false,
        details: {
          ref,
          expectedDigest,
          actualDigest,
        },
      });
    }
  }
}

async function readFileDigest(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function toTenantPathSegment(tenantId: string): string {
  const safePattern = /^[A-Za-z0-9._-]+$/;
  if (
    safePattern.test(tenantId) &&
    tenantId !== "." &&
    tenantId !== ".." &&
    !tenantId.startsWith(".") &&
    !tenantId.startsWith("-")
  ) {
    return tenantId;
  }

  // 对不安全租户标识做可读化 + 指纹化，既避免路径穿越，也保留排障时的人工可读性。
  const readable = tenantId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const prefix = readable.length > 0 && readable !== "." && readable !== ".." ? readable : "tenant";
  return `${prefix}-${sha256(tenantId).slice(0, 12)}`;
}

function resolveSessionReuseKey(
  mode: CompiledAgentSpec["sessionReusePolicy"]["mode"],
  task: TaskRecord["envelope"],
): string | undefined {
  if (mode === "within-task") {
    return task.taskId;
  }

  if (mode === "within-thread") {
    const threadId =
      typeof task.input.metadata?.threadId === "string" && task.input.metadata.threadId.trim().length > 0
        ? task.input.metadata.threadId
        : undefined;

    // 对话线程的复用键必须优先绑定 thread/correlation 语义，而不是父任务 DAG 关系。
    return threadId ?? task.trace.correlationId ?? task.trace.parentTaskId;
  }

  return undefined;
}
