import path from "node:path";

import { ensureDir, readJsonFile, writeJsonFile } from "../../../packages/agent-platform-shared/src/index.js";

interface ActiveVersionState {
  activeVersions: Record<string, string>;
}

export class FileSystemSpecVersionStore {
  private readonly filePath: string;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, "spec-registry", "active-versions.json");
  }

  async initialize(): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    try {
      await readJsonFile<ActiveVersionState>(this.filePath);
    } catch {
      await writeJsonFile(this.filePath, { activeVersions: {} satisfies Record<string, string> });
    }
  }

  async getActiveVersion(agentType: string, availableVersions: string[]): Promise<string | undefined> {
    const state = await this.readState();
    const configured = state.activeVersions[agentType];
    if (configured && availableVersions.includes(configured)) {
      return configured;
    }
    // 没有显式激活版本时，默认选择当前可用版本中的最高版本，便于灰度后自动前移。
    return [...availableVersions].sort(compareVersions).at(-1);
  }

  async setActiveVersion(agentType: string, version: string): Promise<{
    previousVersion?: string;
    activeVersion: string;
  }> {
    const state = await this.readState();
    const previousVersion = state.activeVersions[agentType];
    state.activeVersions[agentType] = version;
    await writeJsonFile(this.filePath, state);
    return {
      previousVersion,
      activeVersion: version,
    };
  }

  private async readState(): Promise<ActiveVersionState> {
    await this.initialize();
    return readJsonFile<ActiveVersionState>(this.filePath);
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
}
