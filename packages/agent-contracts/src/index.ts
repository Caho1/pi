export interface ArtifactRef {
  artifactId: string;
  kind: string;
  uri: string;
  digest?: string;
  mediaType?: string;
  title?: string;
  sizeBytes?: number;
}

export interface ToolPolicy {
  mode: "allowlist" | "denylist";
  tools: string[];
}

export interface ModelPolicy {
  preferredRole?: "default" | "smol" | "slow" | "plan";
  providerAllowlist: string[];
  modelAllowlist?: string[];
  failoverOrder?: Array<{ provider: string; model?: string }>;
  maxAttemptsPerProvider?: number;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxTokens?: number;
}

export interface WorkspacePolicy {
  mode: "readonly" | "ephemeral" | "git-worktree" | "container";
  retainOnFailure: boolean;
  network: "disabled" | "restricted" | "allowed";
  maxDiskMb: number;
  ttlMinutes: number;
}

export interface CompactionPolicy {
  mode: "default" | "safeguard" | "manual-only";
  preserveToolOutputs?: boolean;
  preserveRecentTurns?: number;
  summarizeOlderThanTurns?: number;
  emitCompactionDiagnostics: boolean;
}

export interface OutputContract {
  mode: "text" | "json" | "tool-submission";
  schema?: Record<string, unknown>;
  requireSubmitResultTool: boolean;
  textFallbackAllowed: boolean;
}

export interface SessionReusePolicy {
  mode: "none" | "within-task" | "within-thread";
  persistent: boolean;
}

export interface SubagentPolicy {
  enabled: boolean;
  maxDepth: number;
  maxBreadth: number;
  maxParallel: number;
  inheritWorkspace: boolean;
  inheritToolPolicy: boolean;
  inheritModelPolicy: boolean;
}

export interface CompletionPolicy {
  requirePromptResolved: boolean;
  requireTerminalEvent: boolean;
  requireNoPendingWork: boolean;
  requireSubmitResult: boolean;
  settledTimeoutMs: number;
}

export interface ExtensionGovernancePolicy {
  allowedExtensionRefs: string[];
  allowRuntimeInstall: boolean;
  allowWorkspaceDiscovery: boolean;
  hashPinned: boolean;
}

export interface CostPolicy {
  maxCostUsd?: number;
  maxTokens?: number;
  warnAtPercent?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  retryableErrors: string[];
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface TaskEnvelope {
  taskId: string;
  runRequestId: string;
  idempotencyKey: string;
  tenantId: string;
  taskType: string;
  agentType: string;
  agentVersionSelector?: string;
  priority: "p0" | "p1" | "p2" | "p3";
  triggerType: "sync" | "async" | "callback";
  timeoutMs: number;
  deadlineAt?: string;
  callback?: {
    url?: string;
    topic?: string;
    headers?: Record<string, string>;
  };
  input: {
    prompt: string;
    structuredInput?: Record<string, unknown>;
    contextRefs?: ArtifactRef[];
    metadata?: Record<string, unknown>;
  };
  constraints?: {
    maxCostUsd?: number;
    maxTokens?: number;
    allowWrite?: boolean;
    allowNetwork?: boolean;
    allowSubagents?: boolean;
    requireHumanApproval?: boolean;
  };
  trace: {
    correlationId: string;
    parentTaskId?: string;
    requester?: string;
    sourceSystem?: string;
  };
}

export interface CreateTaskRequest {
  idempotencyKey: string;
  tenantId: string;
  taskType: string;
  agentType?: string;
  agentVersionSelector?: string;
  priority: "p0" | "p1" | "p2" | "p3";
  triggerType: "sync" | "async" | "callback";
  timeoutMs: number;
  deadlineAt?: string;
  callback?: TaskEnvelope["callback"];
  input: TaskEnvelope["input"];
  constraints?: TaskEnvelope["constraints"];
  trace: TaskEnvelope["trace"];
}

export interface AgentSourceSpec {
  agentType: string;
  version: string;
  displayName: string;
  description?: string;
  soulMd?: string;
  agentMd?: string;
  agentsFiles?: Array<{ path: string; content: string }>;
  skillRefs: string[];
  extensionRefs: string[];
  extensionDigests?: Record<string, string>;
  promptTemplates?: string[];
  defaultModelPolicy: ModelPolicy;
  defaultToolPolicy: ToolPolicy;
  defaultWorkspacePolicy: WorkspacePolicy;
  defaultCompactionPolicy: CompactionPolicy;
  outputContract?: OutputContract;
  sessionReusePolicy?: SessionReusePolicy;
  subagentPolicy?: SubagentPolicy;
  completionPolicy?: CompletionPolicy;
  extensionGovernance?: ExtensionGovernancePolicy;
  costPolicy?: CostPolicy;
  retryPolicy?: RetryPolicy;
  metadata?: Record<string, unknown>;
}

export interface CompiledAgentSpec {
  specId: string;
  agentType: string;
  version: string;
  displayName: string;
  sdkCompatibility: {
    packageName: "@mariozechner/pi-coding-agent";
    exactVersion: string;
    adapterVersion: string;
    regressionSuiteVersion?: string;
  };
  prompts: {
    preservePiDefaultSystemPrompt: boolean;
    systemPrompt?: string;
    appendSystemPrompts: string[];
    agentsFiles: Array<{ path: string; content: string }>;
  };
  resources: {
    skillRefs: string[];
    extensionRefs: string[];
    extensionDigests: Record<string, string>;
    promptTemplateRefs: string[];
  };
  toolPolicy: ToolPolicy;
  modelPolicy: ModelPolicy;
  workspacePolicy: WorkspacePolicy;
  compactionPolicy: CompactionPolicy;
  outputContract: OutputContract;
  sessionReusePolicy: SessionReusePolicy;
  subagentPolicy: SubagentPolicy;
  completionPolicy: CompletionPolicy;
  extensionGovernance: ExtensionGovernancePolicy;
  costPolicy: CostPolicy;
  retryPolicy: RetryPolicy;
  buildInfo: {
    builtAt: string;
    builtBy: string;
    sourceDigest: string;
    sourceCommit?: string;
  };
}

export type FailureStage =
  | "validation"
  | "routing"
  | "workspace"
  | "platform"
  | "model"
  | "tool"
  | "subagent"
  | "result-parse"
  | "artifact-upload"
  | "callback";

export interface PlatformError {
  stage: FailureStage;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface RunResult<T = Record<string, unknown>> {
  taskId: string;
  runId: string;
  specId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "partial";
  completion: {
    barrier: "settled-barrier";
    promptResolved: boolean;
    terminalEventSeen: boolean;
    noPendingBackgroundWork: boolean;
    finalizerPassed: boolean;
  };
  result?: {
    text?: string;
    structured?: T;
    submissionMode: "submit_result" | "assistant_text" | "none";
  };
  artifacts: ArtifactRef[];
  usage?: {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCostUsd?: number;
    turns?: number;
    subagentCount?: number;
  };
  compaction?: {
    happened: boolean;
    count?: number;
    policyMode?: string;
  };
  diagnostics?: {
    retries?: number;
    failoverAttempts?: number;
    warnings?: string[];
    failures?: Array<{
      stage: FailureStage;
      code: string;
      message: string;
      retryable: boolean;
    }>;
  };
  error?: PlatformError;
  timestamps: {
    queuedAt?: string;
    startedAt: string;
    finishedAt?: string;
  };
}

export interface SubmitResultPayload {
  summary?: string;
  structured?: Record<string, unknown>;
  artifacts?: Array<{
    logicalName: string;
    path?: string;
    uri?: string;
  }>;
  quality?: {
    confidence?: number;
    incomplete?: boolean;
    notes?: string[];
  };
}

export type TaskLifecycleStatus =
  | "RECEIVED"
  | "DEDUPING"
  | "REJECTED"
  | "ROUTED"
  | "PREPARING"
  | "RUNNING"
  | "SETTLING"
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLING"
  | "CANCELLED";

export interface PlatformRunEvent {
  type: string;
  rawType: string;
  runId: string;
  taskId: string;
  specId: string;
  timestamp: string;
  delta?: string;
  accumulatedText?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: Record<string, unknown>;
  isError?: boolean;
  raw: unknown;
}

export interface TaskRecord {
  taskId: string;
  idempotencyFingerprint: string;
  envelope: TaskEnvelope;
  compiledSpec: CompiledAgentSpec;
  status: TaskLifecycleStatus;
  latestRunId?: string;
  result?: RunResult;
  artifacts: ArtifactRef[];
  error?: PlatformError;
  createdAt: string;
  updatedAt: string;
}
