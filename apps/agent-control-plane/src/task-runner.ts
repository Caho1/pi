import type { TaskRecord } from "../../../packages/agent-contracts/src/index.js";
import {
  JsonFileTaskRepository,
  MemoryMetrics,
  mapRunStatusToTaskStatus,
  nowIso,
} from "../../../packages/agent-platform-shared/src/index.js";
import type { TaskProcessor } from "../../agent-worker/src/index.js";
import { FileSystemAuditLogStore } from "./audit-log.js";
import { CallbackDispatcher } from "./callback-dispatcher.js";
import { TaskDeadLetterStore } from "./task-dead-letter.js";

export class TaskExecutionCoordinator {
  constructor(
    private readonly options: {
      repository: JsonFileTaskRepository;
      processor: TaskProcessor;
      callbackDispatcher: CallbackDispatcher;
      taskDeadLetterStore: TaskDeadLetterStore;
      auditLogStore?: FileSystemAuditLogStore;
      metrics?: MemoryMetrics;
    },
  ) {}

  async process(taskId: string): Promise<void> {
    const current = await this.options.repository.get(taskId);
    if (!current) {
      throw new Error(`Task '${taskId}' not found`);
    }

    const preparingRecord: TaskRecord = {
      ...current,
      status: "PREPARING",
      updatedAt: nowIso(),
    };
    await this.options.repository.save(preparingRecord);

    const runningRecord: TaskRecord = {
      ...preparingRecord,
      status: "RUNNING",
      updatedAt: nowIso(),
    };
    await this.options.repository.save(runningRecord);

    const result = await this.options.processor.process(runningRecord);
    const nextStatus = mapRunStatusToTaskStatus(result.status);
    const updatedRecord: TaskRecord = {
      ...runningRecord,
      latestRunId: result.runId,
      status: "SETTLING",
      updatedAt: nowIso(),
      result,
      artifacts: result.artifacts,
      error: result.error,
    };
    await this.options.repository.save(updatedRecord);

    const finalizedRecord: TaskRecord = {
      ...updatedRecord,
      status: nextStatus,
      updatedAt: nowIso(),
    };
    await this.options.repository.save(finalizedRecord);
    await this.options.auditLogStore?.appendFromRecord(finalizedRecord);
    this.recordMetrics(finalizedRecord);

    if (runningRecord.envelope.callback?.url) {
      await this.options.callbackDispatcher.dispatch(
        runningRecord.envelope.callback.url,
        {
          eventType: "task.completed",
          taskId: finalizedRecord.taskId,
          runId: finalizedRecord.latestRunId,
          specId: finalizedRecord.compiledSpec.specId,
          status: finalizedRecord.result?.status ?? "failed",
          result: finalizedRecord.result?.result,
          artifacts: finalizedRecord.artifacts,
        },
        runningRecord.envelope.callback.headers,
      );
    }
  }

  async processSafely(taskId: string): Promise<void> {
    try {
      await this.process(taskId);
    } catch (error) {
      await this.handleFailure(taskId, error);
    }
  }

  async handleFailure(taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.options.taskDeadLetterStore.append({
      taskId,
      stage: "queue",
      message,
    });

    const record = await this.options.repository.get(taskId);
    if (!record) {
      return;
    }

    await this.options.repository.save({
      ...record,
      status: "FAILED",
      updatedAt: nowIso(),
      error: {
        stage: "platform",
        code: "task.processing_failed",
        message,
        retryable: false,
      },
    });
  }

  private recordMetrics(record: TaskRecord): void {
    const metrics = this.options.metrics;
    if (!metrics || !record.result) {
      return;
    }

    // 按最终任务状态累计收敛指标，方便控制面直接做成功率与失败率统计。
    const statusKey = `task_run_${record.status.toLowerCase()}_total`;
    metrics.increment(statusKey);

    const startedAt = new Date(record.result.timestamps.startedAt).getTime();
    const finishedAt = record.result.timestamps.finishedAt
      ? new Date(record.result.timestamps.finishedAt).getTime()
      : startedAt;
    if (Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) {
      metrics.increment("task_run_duration_ms_total", finishedAt - startedAt);
    }

    const queuedAt = record.result.timestamps.queuedAt
      ? new Date(record.result.timestamps.queuedAt).getTime()
      : new Date(record.createdAt).getTime();
    if (Number.isFinite(queuedAt) && Number.isFinite(startedAt) && startedAt >= queuedAt) {
      metrics.increment("task_queue_lag_ms_total", startedAt - queuedAt);
    }

    if (record.result.usage?.inputTokens !== undefined) {
      metrics.increment("task_run_tokens_input_total", record.result.usage.inputTokens);
    }
    if (record.result.usage?.outputTokens !== undefined) {
      metrics.increment("task_run_tokens_output_total", record.result.usage.outputTokens);
    }
    if (record.result.usage?.estimatedCostUsd !== undefined) {
      metrics.increment("task_run_cost_usd_total", record.result.usage.estimatedCostUsd);
    }
    if (record.result.compaction?.happened) {
      metrics.increment("task_run_compaction_total");
    }
    if ((record.result.diagnostics?.retries ?? 0) > 0) {
      metrics.increment("task_run_retry_total", record.result.diagnostics?.retries ?? 0);
    }
    if ((record.result.diagnostics?.failoverAttempts ?? 0) > 0) {
      metrics.increment("task_run_failover_total", record.result.diagnostics?.failoverAttempts ?? 0);
    }
    if ((record.result.usage?.subagentCount ?? 0) > 0) {
      metrics.increment("subagent_spawn_total", record.result.usage?.subagentCount ?? 0);
    }
  }
}
