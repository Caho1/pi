import type { TaskRecord } from "../../../packages/agent-contracts/src/index.js";
import { JsonFileTaskRepository, nowIso } from "../../../packages/agent-platform-shared/src/index.js";

interface DashboardTotals {
  tasks: number;
  costUsd: number;
  averageDurationMs: number;
  slaBreaches: number;
}

interface TenantRow {
  tenantId: string;
  tasks: number;
  costUsd: number;
}

interface ProviderRow {
  provider: string;
  model: string;
  tasks: number;
  costUsd: number;
}

export class TaskDashboardService {
  constructor(private readonly repository: JsonFileTaskRepository) {}

  async getOverview(): Promise<{
    generatedAt: string;
    totals: DashboardTotals;
    byStatus: Record<string, number>;
    byTenant: TenantRow[];
    byProvider: ProviderRow[];
  }> {
    const records = await this.repository.list();
    return {
      generatedAt: nowIso(),
      totals: buildTotals(records),
      byStatus: countByStatus(records),
      byTenant: summarizeTenants(records),
      byProvider: summarizeProviders(records),
    };
  }

  async getTenantOverview(tenantId: string): Promise<{
    generatedAt: string;
    tenantId: string;
    totals: DashboardTotals;
    byStatus: Record<string, number>;
    byTaskType: Record<string, number>;
    providers: ProviderRow[];
  }> {
    const records = (await this.repository.list()).filter((record) => record.envelope.tenantId === tenantId);
    return {
      generatedAt: nowIso(),
      tenantId,
      totals: buildTotals(records),
      byStatus: countByStatus(records),
      byTaskType: countByTaskType(records),
      providers: summarizeProviders(records),
    };
  }
}

function buildTotals(records: TaskRecord[]): DashboardTotals {
  const durations = records
    .map(calculateDurationMs)
    .filter((value): value is number => value !== undefined);

  return {
    tasks: records.length,
    costUsd: round(records.reduce((sum, record) => sum + (record.result?.usage?.estimatedCostUsd ?? 0), 0)),
    averageDurationMs:
      durations.length > 0
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0,
    // 超时状态和实际时长超过业务 timeoutMs 都记为 SLA breach，便于先做平台级看板。
    slaBreaches: records.filter(isSlaBreached).length,
  };
}

function countByStatus(records: TaskRecord[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const record of records) {
    summary[record.status] = (summary[record.status] ?? 0) + 1;
  }
  return summary;
}

function countByTaskType(records: TaskRecord[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const record of records) {
    summary[record.envelope.taskType] = (summary[record.envelope.taskType] ?? 0) + 1;
  }
  return summary;
}

function summarizeTenants(records: TaskRecord[]): TenantRow[] {
  const grouped = new Map<string, TenantRow>();
  for (const record of records) {
    const key = record.envelope.tenantId;
    const current = grouped.get(key) ?? {
      tenantId: key,
      tasks: 0,
      costUsd: 0,
    };
    current.tasks += 1;
    current.costUsd = round(current.costUsd + (record.result?.usage?.estimatedCostUsd ?? 0));
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(sortRows);
}

function summarizeProviders(records: TaskRecord[]): ProviderRow[] {
  const grouped = new Map<string, ProviderRow>();
  for (const record of records) {
    const provider = record.result?.usage?.provider;
    const model = record.result?.usage?.model;
    if (!provider || !model) {
      continue;
    }

    const key = `${provider}:${model}`;
    const current = grouped.get(key) ?? {
      provider,
      model,
      tasks: 0,
      costUsd: 0,
    };
    current.tasks += 1;
    current.costUsd = round(current.costUsd + (record.result?.usage?.estimatedCostUsd ?? 0));
    grouped.set(key, current);
  }
  return [...grouped.values()].sort(sortRows);
}

function sortRows(
  left: { tasks: number; costUsd: number; tenantId?: string; provider?: string; model?: string },
  right: { tasks: number; costUsd: number; tenantId?: string; provider?: string; model?: string },
): number {
  return (
    right.tasks - left.tasks ||
    right.costUsd - left.costUsd ||
    `${left.tenantId ?? ""}${left.provider ?? ""}${left.model ?? ""}`.localeCompare(
      `${right.tenantId ?? ""}${right.provider ?? ""}${right.model ?? ""}`,
    )
  );
}

function calculateDurationMs(record: TaskRecord): number | undefined {
  const startedAt = record.result?.timestamps.startedAt;
  const finishedAt = record.result?.timestamps.finishedAt;
  if (!startedAt || !finishedAt) {
    return undefined;
  }

  const start = new Date(startedAt).getTime();
  const finish = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
    return undefined;
  }
  return finish - start;
}

function isSlaBreached(record: TaskRecord): boolean {
  if (record.status === "TIMED_OUT") {
    return true;
  }
  const durationMs = calculateDurationMs(record);
  return durationMs !== undefined && durationMs > record.envelope.timeoutMs;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
