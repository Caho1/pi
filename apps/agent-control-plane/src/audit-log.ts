import fs from "node:fs/promises";
import path from "node:path";

import type { TaskRecord } from "../../../packages/agent-contracts/src/index.js";
import { ensureDir, nowIso } from "../../../packages/agent-platform-shared/src/index.js";

export interface AuditLogEntry {
  timestamp: string;
  taskId: string;
  runId?: string;
  specId: string;
  tenantId: string;
  sdkVersion: string;
  adapterVersion: string;
  regressionSuiteVersion?: string;
  provider?: string;
  model?: string;
  workspaceMode: string;
  compactionHappened: boolean;
  failoverAttempts: number;
  submitResultUsed: boolean;
  artifactsCount: number;
  finalStatus: string;
}

export class FileSystemAuditLogStore {
  private readonly filePath: string;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, "audit", "audit.jsonl");
  }

  async appendFromRecord(record: TaskRecord): Promise<void> {
    const entry: AuditLogEntry = {
      timestamp: nowIso(),
      taskId: record.taskId,
      runId: record.latestRunId,
      specId: record.compiledSpec.specId,
      tenantId: record.envelope.tenantId,
      sdkVersion: record.compiledSpec.sdkCompatibility.exactVersion,
      adapterVersion: record.compiledSpec.sdkCompatibility.adapterVersion,
      regressionSuiteVersion: record.compiledSpec.sdkCompatibility.regressionSuiteVersion,
      provider: record.result?.usage?.provider,
      model: record.result?.usage?.model,
      workspaceMode: record.compiledSpec.workspacePolicy.mode,
      compactionHappened: record.result?.compaction?.happened ?? false,
      failoverAttempts: record.result?.diagnostics?.failoverAttempts ?? 0,
      submitResultUsed: record.result?.result?.submissionMode === "submit_result",
      artifactsCount: record.artifacts.length,
      finalStatus: record.status,
    };

    await ensureDir(path.dirname(this.filePath));
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async readAll(): Promise<string> {
    return fs.readFile(this.filePath, "utf8");
  }
}
