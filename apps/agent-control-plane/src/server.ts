import path from "node:path";

import Fastify, { type FastifyInstance } from "fastify";

import type {
  CreateTaskRequest,
  RunResult,
  TaskLifecycleStatus,
  TaskRecord,
} from "../../../packages/agent-contracts/src/index.js";
import {
  applyConstraintOverrides,
  createIdempotencyFingerprint,
  DefaultSpecCompiler,
  FileSystemAgentRegistry,
  JsonFileTaskRepository,
  loadPlatformRuntimeConfig,
  mapRunStatusToTaskStatus,
  MemoryMetrics,
  nowIso,
  randomId,
  TaskRouter,
} from "../../../packages/agent-platform-shared/src/index.js";
import {
  DefaultEventTranslator,
  DefaultPiExecutor,
  DefaultPiResourceAssembler,
  DefaultTaskProcessor,
  FileSystemArtifactStore,
  FileSystemTraceStore,
  FileSystemWorkspaceManager,
  type TaskProcessor,
} from "../../agent-worker/src/index.js";
import { FileSystemAuditLogStore } from "./audit-log.js";
import { CallbackDispatcher } from "./callback-dispatcher.js";
import { TaskDashboardService } from "./dashboard.js";
import { translateExpertProfileBusinessStructured } from "./expert-profile-dictionary-translation.js";
import { TaskDeadLetterStore } from "./task-dead-letter.js";
import { InlineTaskQueue, type TaskQueue } from "./task-queue.js";
import { TaskExecutionCoordinator } from "./task-runner.js";
import { FileSystemSpecVersionStore } from "./spec-version-store.js";

interface SubmittedTask {
  record: TaskRecord;
  httpStatus: number;
  includeRunResult: boolean;
}

interface ExpertProfileExtractRequest {
  url?: string;
  requestId?: string;
  tenantId?: string;
  sourceSystem?: string;
  timeoutMs?: number;
  approvalToken?: string;
}

function readHeaderToken(headers: Record<string, unknown>): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch?.[1]?.trim()) {
      return bearerMatch[1].trim();
    }
  }

  const xApiToken = headers["x-api-token"];
  if (typeof xApiToken === "string" && xApiToken.trim().length > 0) {
    return xApiToken.trim();
  }

  const xExpertProfileToken = headers["x-expert-profile-token"];
  if (typeof xExpertProfileToken === "string" && xExpertProfileToken.trim().length > 0) {
    return xExpertProfileToken.trim();
  }

  return undefined;
}

export async function buildControlPlaneApp(options?: {
  runtimeRoot?: string;
  registryRoot?: string;
  processor?: TaskProcessor;
  callbackDispatcher?: CallbackDispatcher;
  taskQueue?: TaskQueue;
}): Promise<FastifyInstance> {
  const runtimeRoot = path.resolve(options?.runtimeRoot ?? "runtime");
  const repository = new JsonFileTaskRepository(runtimeRoot);
  await repository.initialize();
  const runtimeConfig = loadPlatformRuntimeConfig();

  const metrics = new MemoryMetrics();
  const registry = new FileSystemAgentRegistry(
    path.resolve(options?.registryRoot ?? "packages/agent-specs/agents"),
  );
  const specVersionStore = new FileSystemSpecVersionStore(runtimeRoot);
  await specVersionStore.initialize();
  const compiler = new DefaultSpecCompiler({
    exactSdkVersion: "0.66.1",
    adapterVersion: "1.0.0",
    regressionSuiteVersion: "2026-04-14",
  });
  const router = new TaskRouter();
  const traceStore = new FileSystemTraceStore(runtimeRoot);

  const processor =
    options?.processor ??
    new DefaultTaskProcessor(
      new FileSystemWorkspaceManager(runtimeRoot),
      new DefaultPiExecutor(
        new DefaultPiResourceAssembler(runtimeRoot),
        new DefaultEventTranslator(),
        traceStore,
        new FileSystemArtifactStore(runtimeRoot),
      ),
    );
  const callbackDispatcher =
    options?.callbackDispatcher ??
    new CallbackDispatcher({
      runtimeRoot,
      retryPolicy: runtimeConfig.callbacks,
      allowedDomains: runtimeConfig.callbacks.allowedDomains,
    });
  const taskDeadLetterStore = new TaskDeadLetterStore(runtimeRoot);
  const auditLogStore = new FileSystemAuditLogStore(runtimeRoot);
  const dashboardService = new TaskDashboardService(repository);
  const coordinator = new TaskExecutionCoordinator({
    repository,
    processor,
    callbackDispatcher,
    taskDeadLetterStore,
    auditLogStore,
    metrics,
  });
  const queue =
    options?.taskQueue ??
    new InlineTaskQueue(async (taskId) => {
      await coordinator.processSafely(taskId);
    });

  function serializeTask(record: TaskRecord) {
    return {
      taskId: record.taskId,
      runId: record.latestRunId,
      status: record.status,
      specId: record.compiledSpec.specId,
      taskType: record.envelope.taskType,
      agentType: record.envelope.agentType,
      result: record.result?.result,
      artifacts: record.artifacts,
      error: record.error,
      timestamps: {
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        startedAt: record.result?.timestamps.startedAt,
        finishedAt: record.result?.timestamps.finishedAt,
      },
    };
  }

  function serializeSubmittedTask(submitted: SubmittedTask) {
    if (submitted.includeRunResult && submitted.record.result) {
      return {
        ...serializeTask(submitted.record),
        runResult: submitted.record.result,
      };
    }

    return serializeTask(submitted.record);
  }

  // 把通用任务提交流程收敛到一个函数里，避免平台通用接口和业务包装接口
  // 各自复制一份“创建任务 -> 入队 -> 等待 -> 取结果”的逻辑，后续维护更稳。
  async function submitTask(body: CreateTaskRequest): Promise<SubmittedTask> {
    validateTaskRequest(body);

    const fingerprint = createIdempotencyFingerprint({
      tenantId: body.tenantId,
      taskType: body.taskType,
      idempotencyKey: body.idempotencyKey,
    });
    const existing = await repository.findByFingerprint(fingerprint);
    if (existing) {
      metrics.increment("task_deduped_total");
      return {
        record: existing,
        httpStatus: 202,
        includeRunResult: false,
      };
    }

    const taskId = randomId("task");
    const agentType = router.resolve(body.taskType, body.agentType);
    const selectedVersion =
      body.agentVersionSelector ??
      (await specVersionStore.getActiveVersion(agentType, await registry.listVersions(agentType)));
    const envelope = {
      ...body,
      taskId,
      runRequestId: randomId("req"),
      agentType,
      agentVersionSelector: selectedVersion,
    };

    const source = await registry.getSourceSpec(agentType, selectedVersion);
    const compiledSpec = applyConstraintOverrides(envelope, await compiler.compile(source));
    const approvalError = evaluateApprovalGate(envelope, compiledSpec);
    if (approvalError) {
      const rejectedRecord: TaskRecord = {
        taskId,
        idempotencyFingerprint: fingerprint,
        envelope,
        compiledSpec,
        status: "REJECTED",
        artifacts: [],
        error: approvalError,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      await repository.save(rejectedRecord);
      metrics.increment("task_rejected_total");
      return {
        record: rejectedRecord,
        httpStatus: 202,
        includeRunResult: false,
      };
    }

    const record: TaskRecord = {
      taskId,
      idempotencyFingerprint: fingerprint,
      envelope,
      compiledSpec,
      status: "ROUTED",
      artifacts: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await repository.save(record);
    metrics.increment("task_run_total");

    const completion = queue.enqueue(taskId);
    if (body.triggerType === "sync") {
      await waitForTerminalTaskState(repository, taskId, body.timeoutMs);
    } else {
      void completion.catch((error) => {
        console.error("Task completion failed", taskId, error);
      });
    }

    const freshRecord = (await repository.get(taskId)) ?? record;
    const includeRunResult = body.triggerType === "sync" && Boolean(freshRecord.result);

    return {
      record: freshRecord,
      httpStatus: includeRunResult ? 200 : 202,
      includeRunResult,
    };
  }

  function validateExpertProfileExtractRequest(
    body: Partial<ExpertProfileExtractRequest>,
  ): asserts body is ExpertProfileExtractRequest & { url: string } {
    if (!body.url || typeof body.url !== "string" || body.url.trim().length === 0) {
      throw new Error("Missing required field 'url'");
    }

    if (body.timeoutMs !== undefined && (!Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0)) {
      throw new Error("Field 'timeoutMs' must be a positive number");
    }
  }

  // 这层薄包装把平台协议细节藏在控制面内部：上游业务系统只传 URL，
  // 控制面仍然创建标准任务，从而保留原有的审计、trace 和 artifact 落盘能力。
  function buildExpertProfileTaskRequest(
    body: ExpertProfileExtractRequest & { url: string },
  ): {
    requestId: string;
    taskRequest: CreateTaskRequest;
  } {
    const requestId = body.requestId?.trim() || randomId("expert-profile");
    const approvalToken = body.approvalToken?.trim() || `business-wrapper:${requestId}`;

    return {
      requestId,
      taskRequest: {
        idempotencyKey: requestId,
        tenantId: body.tenantId?.trim() || "digit-system",
        taskType: "expert.profile.extract",
        agentType: "expert-profile",
        priority: "p1",
        triggerType: "sync",
        timeoutMs: body.timeoutMs ?? 180_000,
        input: {
          prompt: body.url.trim(),
          metadata: {
            approvalToken,
          },
        },
        trace: {
          correlationId: requestId,
          sourceSystem: body.sourceSystem?.trim() || "expert-profile-business-api",
        },
      },
    };
  }

  function mapExpertProfileResponseStatus(record: TaskRecord): number {
    switch (record.status) {
      case "SUCCEEDED":
      case "PARTIAL":
        return 200;
      case "REJECTED":
        return 400;
      case "TIMED_OUT":
        return 504;
      case "FAILED":
        return 502;
      case "CANCELLED":
      case "CANCELLING":
        return 409;
      default:
        return 202;
    }
  }

  function extractBusinessTokenUsage(record?: TaskRecord) {
    const promptTokens = record?.result?.usage?.inputTokens ?? 0;
    const completionTokens = record?.result?.usage?.outputTokens ?? 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  function serializeExpertProfileResponse(input: {
    requestId: string;
    record?: TaskRecord;
    validationError?: string;
    authError?: string;
  }) {
    if (!input.record) {
      return {
        success: false,
        status: null,
        requestId: input.requestId,
        taskId: null,
        runId: null,
        ...extractBusinessTokenUsage(),
        data: null,
        error: {
          stage: "validation",
          code: input.authError ? "unauthorized" : "invalid_request",
          message: input.authError ?? input.validationError ?? "Invalid request",
          retryable: false,
        },
      };
    }

    return {
      success: input.record.status === "SUCCEEDED" || input.record.status === "PARTIAL",
      status: input.record.status,
      requestId: input.requestId,
      taskId: input.record.taskId,
      runId: input.record.latestRunId ?? null,
      ...extractBusinessTokenUsage(input.record),
      data: translateExpertProfileBusinessStructured(input.record.result?.result?.structured ?? null),
      error: input.record.error ?? input.record.result?.error ?? null,
    };
  }

  const app = Fastify({ logger: false });

  app.post("/v1/agent-tasks", async (request, reply) => {
    const body = request.body as CreateTaskRequest;
    const submitted = await submitTask(body);
    return reply.code(submitted.httpStatus).send(serializeSubmittedTask(submitted));
  });

  app.post("/v1/expert-profiles/extract", async (request, reply) => {
    const body = request.body as ExpertProfileExtractRequest;
    const configuredToken = runtimeConfig.businessApi.expertProfileToken;
    if (configuredToken) {
      // 业务接口默认使用共享 token 做最小鉴权，避免上游系统直接裸调用。
      const requestToken = readHeaderToken(request.headers as Record<string, unknown>);
      if (!requestToken || requestToken !== configuredToken) {
        return reply.code(401).send(
          serializeExpertProfileResponse({
            requestId: body.requestId?.trim() || randomId("expert-profile"),
            authError: "Unauthorized: invalid or missing API token",
          }),
        );
      }
    }

    try {
      validateExpertProfileExtractRequest(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send(
        serializeExpertProfileResponse({
          requestId: body.requestId?.trim() || randomId("expert-profile"),
          validationError: message,
        }),
      );
    }

    const { requestId, taskRequest } = buildExpertProfileTaskRequest(body);
    const submitted = await submitTask(taskRequest);
    return reply
      .code(mapExpertProfileResponseStatus(submitted.record))
      .send(
        serializeExpertProfileResponse({
          requestId,
          record: submitted.record,
        }),
      );
  });

  app.get("/v1/agent-tasks/:taskId", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const record = await repository.get(taskId);
    if (!record) {
      return reply.code(404).send({ message: "Task not found" });
    }
    return serializeTask(record);
  });

  app.post("/v1/agent-tasks/:taskId/cancel", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const cancelled = await processor.cancel(taskId);
    if (!cancelled) {
      return reply.code(404).send({ message: "Task not running" });
    }

    const record = await repository.get(taskId);
    if (record) {
      await repository.save({
        ...record,
        status: "CANCELLING",
        updatedAt: nowIso(),
      });
    }

    return reply.code(202).send({ taskId, status: "CANCELLING" satisfies TaskLifecycleStatus });
  });

  app.post("/v1/agent-tasks/:taskId/retry", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const record = await repository.get(taskId);
    if (!record) {
      return reply.code(404).send({ message: "Task not found" });
    }

    const retried: TaskRecord = {
      ...record,
      status: "ROUTED",
      latestRunId: undefined,
      result: undefined,
      error: undefined,
      artifacts: [],
      updatedAt: nowIso(),
      envelope: {
        ...record.envelope,
        runRequestId: randomId("req"),
      },
    };
    await repository.save(retried);
    const completion = queue.enqueue(taskId);
    void completion.catch((error) => {
      console.error("Retried task failed", taskId, error);
    });

    const fresh = (await repository.get(taskId)) ?? retried;
    return reply.code(202).send(serializeTask(fresh));
  });

  app.get("/v1/agent-tasks/:taskId/artifacts", async (request, reply) => {
    const taskId = (request.params as { taskId: string }).taskId;
    const record = await repository.get(taskId);
    if (!record) {
      return reply.code(404).send({ message: "Task not found" });
    }
    return { taskId, artifacts: record.artifacts };
  });

  app.get("/v1/agent-runs/:runId/trace", async (request, reply) => {
    const runId = (request.params as { runId: string }).runId;
    try {
      const trace = await traceStore.read(runId);
      reply.type("application/x-ndjson");
      return trace;
    } catch {
      return reply.code(404).send({ message: "Trace not found" });
    }
  });

  app.get("/metrics", async () => metrics.snapshot());

  app.get("/v1/agent-specs/:agentType/versions", async (request, reply) => {
    const agentType = (request.params as { agentType: string }).agentType;
    const versions = await registry.listVersions(agentType);
    if (versions.length === 0) {
      return reply.code(404).send({ message: "Agent type not found" });
    }

    return {
      agentType,
      versions,
      activeVersion: await specVersionStore.getActiveVersion(agentType, versions),
    };
  });

  app.post("/v1/agent-specs/:agentType/rollback", async (request, reply) => {
    const agentType = (request.params as { agentType: string }).agentType;
    const versions = await registry.listVersions(agentType);
    if (versions.length === 0) {
      return reply.code(404).send({ message: "Agent type not found" });
    }

    const targetVersion = (request.body as { version?: string } | undefined)?.version;
    if (!targetVersion || !versions.includes(targetVersion)) {
      return reply.code(400).send({ message: "Unknown rollback target version" });
    }

    const previousVersion = await specVersionStore.getActiveVersion(agentType, versions);
    const updated = await specVersionStore.setActiveVersion(agentType, targetVersion);
    return {
      agentType,
      previousVersion,
      activeVersion: updated.activeVersion,
      versions,
    };
  });

  app.get("/v1/dashboard/overview", async () => dashboardService.getOverview());

  app.get("/v1/dashboard/tenants/:tenantId", async (request) => {
    const tenantId = (request.params as { tenantId: string }).tenantId;
    return dashboardService.getTenantOverview(tenantId);
  });

  return app;
}

async function waitForTerminalTaskState(
  repository: JsonFileTaskRepository,
  taskId: string,
  timeoutMs: number,
): Promise<TaskRecord | undefined> {
  const terminalStatuses = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "TIMED_OUT", "CANCELLED", "REJECTED"]);
  const deadline = Date.now() + timeoutMs;
  let lastRecord: TaskRecord | undefined;

  while (Date.now() <= deadline) {
    const record = await repository.get(taskId);
    if (record) {
      lastRecord = record;
    }
    if (record && (terminalStatuses.has(record.status) || record.error)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return lastRecord;
}

function validateTaskRequest(body: Partial<CreateTaskRequest>): asserts body is CreateTaskRequest {
  const required = ["idempotencyKey", "tenantId", "taskType", "priority", "triggerType", "timeoutMs", "input", "trace"] as const;
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      throw new Error(`Missing required field '${field}'`);
    }
  }
  if (!body.input?.prompt) {
    throw new Error("Missing required field 'input.prompt'");
  }
  if (!body.trace?.correlationId) {
    throw new Error("Missing required field 'trace.correlationId'");
  }
}

function evaluateApprovalGate(
  task: CreateTaskRequest & {
    taskId: string;
    runRequestId: string;
    agentType: string;
  },
  spec: TaskRecord["compiledSpec"],
) {
  if (!requiresHumanApproval(task, spec)) {
    return undefined;
  }

  if (hasApprovalEvidence(task.input.metadata)) {
    return undefined;
  }

  return {
    stage: "validation" as const,
    code: "approval.required",
    message: `Task '${task.taskId}' requires human approval before execution`,
    retryable: false,
    details: {
      agentType: task.agentType,
      taskType: task.taskType,
    },
  };
}

function requiresHumanApproval(
  task: CreateTaskRequest,
  spec: TaskRecord["compiledSpec"],
): boolean {
  if (task.constraints?.requireHumanApproval) {
    return true;
  }

  if (spec.workspacePolicy.mode === "container" || spec.workspacePolicy.network !== "disabled") {
    return true;
  }

  return spec.toolPolicy.tools.some((tool) => ["write", "edit", "bash"].includes(tool));
}

function hasApprovalEvidence(metadata: CreateTaskRequest["input"]["metadata"]): boolean {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  if (typeof metadata.approvalToken === "string" && metadata.approvalToken.trim().length > 0) {
    return true;
  }

  if (metadata.approvalApproved === true) {
    return true;
  }

  const approval = metadata.approval;
  return Boolean(
    approval &&
      typeof approval === "object" &&
      ((approval as Record<string, unknown>).approved === true ||
        typeof (approval as Record<string, unknown>).ticketId === "string"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildControlPlaneApp();
  const port = Number(process.env.PORT ?? "3000");
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`agent-control-plane listening on http://127.0.0.1:${port}`);
}

export { CallbackDispatcher } from "./callback-dispatcher.js";
