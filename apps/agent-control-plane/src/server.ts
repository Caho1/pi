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
import { TaskDeadLetterStore } from "./task-dead-letter.js";
import { InlineTaskQueue, type TaskQueue } from "./task-queue.js";
import { TaskExecutionCoordinator } from "./task-runner.js";
import { FileSystemSpecVersionStore } from "./spec-version-store.js";

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

  const app = Fastify({ logger: false });

  app.post("/v1/agent-tasks", async (request, reply) => {
    const body = request.body as CreateTaskRequest;
    validateTaskRequest(body);

    const fingerprint = createIdempotencyFingerprint({
      tenantId: body.tenantId,
      taskType: body.taskType,
      idempotencyKey: body.idempotencyKey,
    });
    const existing = await repository.findByFingerprint(fingerprint);
    if (existing) {
      metrics.increment("task_deduped_total");
      return reply.code(202).send(serializeTask(existing));
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
      return reply.code(202).send(serializeTask(rejectedRecord));
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

    if (body.triggerType === "sync" && freshRecord.result) {
      return reply.code(200).send({
        ...serializeTask(freshRecord),
        runResult: freshRecord.result,
      });
    }

    return reply.code(202).send(serializeTask(freshRecord));
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
