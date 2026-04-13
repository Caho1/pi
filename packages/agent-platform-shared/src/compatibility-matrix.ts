import fs from "node:fs/promises";
import path from "node:path";

import type { CompiledAgentSpec } from "../../agent-contracts/src/index.js";

export interface CompatibilityMatrixEntry {
  sdkVersion: string;
  adapterVersion: string;
  regressionSuiteVersion?: string;
  supportedExtensionRefs?: string[];
  supportedExtensionDigests?: Record<string, string[]>;
}

export class FileSystemCompatibilityMatrix {
  private readonly filePath: string;

  constructor(runtimeRoot: string) {
    this.filePath = path.join(runtimeRoot, "data", "compatibility-matrix.json");
  }

  async initialize(defaultEntries: CompatibilityMatrixEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      await fs.writeFile(this.filePath, `${JSON.stringify(defaultEntries, null, 2)}\n`, "utf8");
    }
  }

  async isCompatible(spec: CompiledAgentSpec): Promise<boolean> {
    const entries = await this.readEntries();
    return entries.some(
      (entry) =>
        entry.sdkVersion === spec.sdkCompatibility.exactVersion &&
        entry.adapterVersion === spec.sdkCompatibility.adapterVersion &&
        this.matchesRegressionSuite(entry, spec) &&
        this.matchesExtensionDigests(entry, spec),
    );
  }

  async readEntries(): Promise<CompatibilityMatrixEntry[]> {
    return JSON.parse(await fs.readFile(this.filePath, "utf8")) as CompatibilityMatrixEntry[];
  }

  private matchesRegressionSuite(entry: CompatibilityMatrixEntry, spec: CompiledAgentSpec): boolean {
    if (!entry.regressionSuiteVersion || !spec.sdkCompatibility.regressionSuiteVersion) {
      return true;
    }
    return entry.regressionSuiteVersion === spec.sdkCompatibility.regressionSuiteVersion;
  }

  private matchesExtensionDigests(entry: CompatibilityMatrixEntry, spec: CompiledAgentSpec): boolean {
    if (!entry.supportedExtensionDigests) {
      return true;
    }

    for (const [ref, digest] of Object.entries(spec.resources.extensionDigests ?? {})) {
      const allowed = entry.supportedExtensionDigests[ref];
      if (!allowed || !allowed.includes(digest)) {
        return false;
      }
    }

    return true;
  }
}
