import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentSourceSpec,
  CompiledAgentSpec,
  CompletionPolicy,
  CostPolicy,
  ExtensionGovernancePolicy,
  OutputContract,
  PlatformError,
  RetryPolicy,
  SessionReusePolicy,
  SubagentPolicy,
  TaskEnvelope,
  TaskLifecycleStatus,
  TaskRecord,
} from "../../agent-contracts/src/index.js";

export function ensureDir(dirPath: string): Promise<void> {
  return fs.mkdir(dirPath, { recursive: true }).then(() => undefined);
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readTextFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortValue(nestedValue)]),
    );
  }

  return value;
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createIdempotencyFingerprint(input: {
  tenantId: string;
  taskType: string;
  idempotencyKey: string;
}): string {
  return sha256(`${input.tenantId}:${input.taskType}:${input.idempotencyKey}`);
}

export class FileSystemAgentRegistry {
  constructor(private readonly specsRoot: string) {}

  async getSourceSpec(agentType: string, version?: string): Promise<AgentSourceSpec> {
    const agentDirs = await this.listAgentDirectories();
    for (const agentDir of agentDirs) {
      const candidate = await this.loadSourceSpec(agentDir);
      if (candidate.agentType === agentType && (!version || candidate.version === version)) {
        return candidate;
      }
    }

    throw new Error(`Unknown agentType '${agentType}' in ${this.specsRoot}`);
  }

  async listVersions(agentType: string): Promise<string[]> {
    const agentDirs = await this.listAgentDirectories();
    const versions: string[] = [];

    for (const agentDir of agentDirs) {
      const candidate = await this.loadSourceSpec(agentDir);
      if (candidate.agentType === agentType) {
        versions.push(candidate.version);
      }
    }

    return versions.sort();
  }

  private async listAgentDirectories(): Promise<string[]> {
    const entries = await fs.readdir(this.specsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(this.specsRoot, entry.name));
  }

  private async loadSourceSpec(agentDir: string): Promise<AgentSourceSpec> {
    const policy = await readJsonFile<AgentSourceSpec & {
      completionPolicy?: CompletionPolicy;
      extensionGovernance?: ExtensionGovernancePolicy;
      costPolicy?: CostPolicy;
      retryPolicy?: RetryPolicy;
      outputContract?: OutputContract;
      sessionReusePolicy?: SessionReusePolicy;
      subagentPolicy?: SubagentPolicy;
    }>(path.join(agentDir, "policy.json"));
    const extensionRefs = resolveSpecPaths(agentDir, policy.extensionRefs ?? []);
    const allowedExtensionRefs = resolveSpecPaths(agentDir, policy.extensionGovernance?.allowedExtensionRefs ?? []);
    const extensionDigests =
      policy.extensionGovernance?.hashPinned === false
        ? undefined
        // hashPinned 开启时，把扩展文件内容摘要编进源规范，确保 specId 与内容绑定。
        : await calculateFileDigests(extensionRefs);

    return {
      ...policy,
      extensionRefs,
      extensionDigests,
      extensionGovernance: policy.extensionGovernance
        ? {
            ...policy.extensionGovernance,
            allowedExtensionRefs,
          }
        : policy.extensionGovernance,
      soulMd: await readTextFileIfExists(path.join(agentDir, "soul.md")),
      agentMd: await readTextFileIfExists(path.join(agentDir, "agent.md")),
      agentsFiles: [],
    };
  }
}

function resolveSpecPaths(baseDir: string, refs: string[]): string[] {
  return refs.map((ref) => (path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref)));
}

async function calculateFileDigests(refs: string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};

  for (const ref of refs) {
    try {
      const stat = await fs.stat(ref);
      if (!stat.isFile()) {
        continue;
      }

      const content = await fs.readFile(ref);
      digests[ref] = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return digests;
}

const DEFAULT_OUTPUT_CONTRACT: OutputContract = {
  mode: "text",
  requireSubmitResultTool: false,
  textFallbackAllowed: true,
};

const DEFAULT_SESSION_REUSE_POLICY: SessionReusePolicy = {
  mode: "none",
  persistent: false,
};

const DEFAULT_SUBAGENT_POLICY: SubagentPolicy = {
  enabled: false,
  maxDepth: 1,
  maxBreadth: 1,
  maxParallel: 1,
  inheritWorkspace: true,
  inheritToolPolicy: true,
  inheritModelPolicy: true,
};

const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  requirePromptResolved: true,
  requireTerminalEvent: true,
  requireNoPendingWork: true,
  requireSubmitResult: false,
  settledTimeoutMs: 3000,
};

const DEFAULT_EXTENSION_GOVERNANCE: ExtensionGovernancePolicy = {
  allowedExtensionRefs: [],
  allowRuntimeInstall: false,
  allowWorkspaceDiscovery: false,
  hashPinned: true,
};

const DEFAULT_COST_POLICY: CostPolicy = {};

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 0,
  retryableErrors: [],
  backoffBaseMs: 100,
  backoffMaxMs: 1000,
};

function buildSubmitResultProtocolPrompt(schema?: Record<string, unknown>): string {
  const schemaText = schema ? JSON.stringify(schema, null, 2) : "{}";
  return [
    "Protocol: submit_result",
    "You must call the `submit_result` tool exactly once before finishing.",
    "Put your final structured business output under the `structured` field.",
    "Do not rely on plain assistant text as the primary result channel.",
    "Expected structured schema:",
    "```json",
    schemaText,
    "```",
  ].join("\n");
}

export class DefaultSpecCompiler {
  constructor(
    private readonly options: {
      exactSdkVersion: string;
      adapterVersion: string;
      regressionSuiteVersion?: string;
      builtBy?: string;
    },
  ) {}

  async compile(source: AgentSourceSpec): Promise<CompiledAgentSpec> {
    const appendSystemPrompts = [
      source.soulMd ? `# soul.md\n${source.soulMd.trim()}` : undefined,
      source.agentMd ? `# agent.md\n${source.agentMd.trim()}` : undefined,
      source.outputContract?.requireSubmitResultTool
        ? buildSubmitResultProtocolPrompt(source.outputContract.schema)
        : undefined,
    ].filter((value): value is string => Boolean(value));

    const outputContract = source.outputContract ?? DEFAULT_OUTPUT_CONTRACT;
    const sourceDigest = `sha256:${sha256(stableStringify(source))}`;
    const builtAt = nowIso();

    const compiledWithoutId: Omit<CompiledAgentSpec, "specId"> = {
      agentType: source.agentType,
      version: source.version,
      displayName: source.displayName,
      sdkCompatibility: {
        packageName: "@mariozechner/pi-coding-agent",
        exactVersion: this.options.exactSdkVersion,
        adapterVersion: this.options.adapterVersion,
        regressionSuiteVersion: this.options.regressionSuiteVersion,
      },
      prompts: {
        preservePiDefaultSystemPrompt: true,
        appendSystemPrompts,
        agentsFiles: source.agentsFiles ?? [],
      },
      resources: {
        skillRefs: source.skillRefs,
        extensionRefs: source.extensionRefs,
        extensionDigests: source.extensionDigests ?? {},
        promptTemplateRefs: source.promptTemplates ?? [],
      },
      toolPolicy: source.defaultToolPolicy,
      modelPolicy: source.defaultModelPolicy,
      workspacePolicy: source.defaultWorkspacePolicy,
      compactionPolicy: source.defaultCompactionPolicy,
      outputContract,
      sessionReusePolicy: source.sessionReusePolicy ?? DEFAULT_SESSION_REUSE_POLICY,
      subagentPolicy: source.subagentPolicy ?? DEFAULT_SUBAGENT_POLICY,
      completionPolicy: {
        ...DEFAULT_COMPLETION_POLICY,
        ...(source.completionPolicy ?? {}),
        requireSubmitResult: outputContract.requireSubmitResultTool,
      },
      extensionGovernance: source.extensionGovernance ?? DEFAULT_EXTENSION_GOVERNANCE,
      costPolicy: source.costPolicy ?? DEFAULT_COST_POLICY,
      retryPolicy: source.retryPolicy ?? DEFAULT_RETRY_POLICY,
      buildInfo: {
        builtAt,
        builtBy: this.options.builtBy ?? "codex",
        sourceDigest,
      },
    };

    const fingerprintSource = {
      ...compiledWithoutId,
      buildInfo: {
        ...compiledWithoutId.buildInfo,
        builtAt: "__normalized__",
      },
    };

    return {
      ...compiledWithoutId,
      specId: `sha256:${sha256(stableStringify(fingerprintSource))}`,
    };
  }
}

export class JsonFileTaskRepository {
  private readonly tasksDir: string;
  private readonly idempotencyFile: string;

  constructor(private readonly runtimeRoot: string) {
    this.tasksDir = path.join(runtimeRoot, "data", "tasks");
    this.idempotencyFile = path.join(runtimeRoot, "data", "idempotency-index.json");
  }

  async initialize(): Promise<void> {
    await ensureDir(this.tasksDir);
    await ensureDir(path.dirname(this.idempotencyFile));
    try {
      await fs.access(this.idempotencyFile);
    } catch {
      await writeJsonFile(this.idempotencyFile, {});
    }
  }

  async save(record: TaskRecord): Promise<void> {
    await writeJsonFile(this.taskFile(record.taskId), record);
    const index = await this.readIdempotencyIndex();
    index[record.idempotencyFingerprint] = record.taskId;
    await writeJsonFile(this.idempotencyFile, index);
  }

  async get(taskId: string): Promise<TaskRecord | undefined> {
    try {
      return await readJsonFile<TaskRecord>(this.taskFile(taskId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async findByFingerprint(fingerprint: string): Promise<TaskRecord | undefined> {
    const index = await this.readIdempotencyIndex();
    const taskId = index[fingerprint];
    if (!taskId) {
      return undefined;
    }
    return this.get(taskId);
  }

  async list(): Promise<TaskRecord[]> {
    const entries = (await fs.readdir(this.tasksDir))
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const records = await Promise.all(
      entries.map((entry) => readJsonFile<TaskRecord>(path.join(this.tasksDir, entry))),
    );
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async update(taskId: string, updater: (record: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    const current = await this.get(taskId);
    if (!current) {
      throw new Error(`Unknown task '${taskId}'`);
    }

    const next = updater(current);
    await this.save(next);
    return next;
  }

  private async readIdempotencyIndex(): Promise<Record<string, string>> {
    return readJsonFile<Record<string, string>>(this.idempotencyFile);
  }

  private taskFile(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }
}

export class TaskRouter {
  constructor(
    private readonly routes: Record<string, string> = {
      "code.review": "reviewer",
      "requirement.analysis": "requirement-analyst",
    },
  ) {}

  resolve(taskType: string, preferredAgentType?: string): string {
    if (preferredAgentType) {
      return preferredAgentType;
    }

    const routed = this.routes[taskType];
    if (!routed) {
      throw new Error(`No agent route configured for taskType '${taskType}'`);
    }

    return routed;
  }
}

export class MemoryMetrics {
  private readonly counters = new Map<string, number>();

  increment(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}

export function mapRunStatusToTaskStatus(status: string): TaskLifecycleStatus {
  switch (status) {
    case "succeeded":
      return "SUCCEEDED";
    case "partial":
      return "PARTIAL";
    case "cancelled":
      return "CANCELLED";
    case "timed_out":
      return "TIMED_OUT";
    default:
      return "FAILED";
  }
}

export function createPlatformError(input: PlatformError): PlatformError {
  return input;
}

export function applyConstraintOverrides(task: TaskEnvelope, spec: CompiledAgentSpec): CompiledAgentSpec {
  const allowWrite = task.constraints?.allowWrite;
  const allowNetwork = task.constraints?.allowNetwork;
  const allowSubagents = task.constraints?.allowSubagents;

  return {
    ...spec,
    workspacePolicy: {
      ...spec.workspacePolicy,
      mode:
        allowWrite === false && spec.workspacePolicy.mode !== "readonly"
          ? "readonly"
          : spec.workspacePolicy.mode,
      network:
        allowNetwork === false
          ? "disabled"
          : allowNetwork === true
            ? "allowed"
            : spec.workspacePolicy.network,
    },
    subagentPolicy: {
      ...spec.subagentPolicy,
      enabled:
        allowSubagents === undefined ? spec.subagentPolicy.enabled : Boolean(allowSubagents),
    },
  };
}

export * from "./runtime-config.js";
export * from "./compatibility-matrix.js";
