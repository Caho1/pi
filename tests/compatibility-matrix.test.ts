import fs from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { FileSystemCompatibilityMatrix } from "../packages/agent-platform-shared/src/index.js";
import type { CompiledAgentSpec } from "../packages/agent-contracts/src/index.js";

describe("FileSystemCompatibilityMatrix", () => {
  test("accepts matching sdk/adapter versions plus regression suite and extension digests", async () => {
    const runtimeRoot = "runtime/test-compatibility-matrix";
    await fs.rm(runtimeRoot, { recursive: true, force: true });

    const matrix = new FileSystemCompatibilityMatrix(runtimeRoot);
    await matrix.initialize([
      {
        sdkVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-14",
        supportedExtensionDigests: {
          "/tmp/ext-a.ts": ["sha256:aaa"],
        },
      },
    ]);

    const spec = {
      sdkCompatibility: {
        exactVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-14",
      },
      resources: {
        extensionDigests: {
          "/tmp/ext-a.ts": "sha256:aaa",
        },
      },
    } as unknown as CompiledAgentSpec;

    await expect(matrix.isCompatible(spec)).resolves.toBe(true);
  });

  test("rejects mismatched regression suite or unsupported extension digests", async () => {
    const runtimeRoot = "runtime/test-compatibility-matrix-mismatch";
    await fs.rm(runtimeRoot, { recursive: true, force: true });

    const matrix = new FileSystemCompatibilityMatrix(runtimeRoot);
    await matrix.initialize([
      {
        sdkVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-14",
        supportedExtensionDigests: {
          "/tmp/ext-a.ts": ["sha256:aaa"],
        },
      },
    ]);

    const regressionMismatch = {
      sdkCompatibility: {
        exactVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-15",
      },
      resources: {
        extensionDigests: {
          "/tmp/ext-a.ts": "sha256:aaa",
        },
      },
    } as unknown as CompiledAgentSpec;
    const extensionMismatch = {
      sdkCompatibility: {
        exactVersion: "0.66.1",
        adapterVersion: "1.0.0",
        regressionSuiteVersion: "2026-04-14",
      },
      resources: {
        extensionDigests: {
          "/tmp/ext-a.ts": "sha256:bbb",
        },
      },
    } as unknown as CompiledAgentSpec;

    await expect(matrix.isCompatible(regressionMismatch)).resolves.toBe(false);
    await expect(matrix.isCompatible(extensionMismatch)).resolves.toBe(false);
  });
});
