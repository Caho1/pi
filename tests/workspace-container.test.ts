import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { FileSystemWorkspaceManager } from "../apps/agent-worker/src/index.js";

describe("container workspace", () => {
  const runtimeRoot = "runtime/test-workspace-container";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("container 模式会准备本地沙箱布局、仓库快照和隔离清单", async () => {
    const repoRoot = path.resolve(runtimeRoot, "source-repo");
    const contextRoot = path.resolve(runtimeRoot, "context");
    const contextFile = path.join(contextRoot, "brief.md");

    await fs.mkdir(repoRoot, { recursive: true });
    await fs.mkdir(contextRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# container repo\n", "utf8");
    await fs.writeFile(contextFile, "上下文输入\n", "utf8");

    const manager = new FileSystemWorkspaceManager(runtimeRoot);
    const lease = await manager.prepare({
      taskId: "task-container",
      tenantId: "acme",
      mode: "container",
      retainOnFailure: false,
      sourceRepoPath: repoRoot,
      contextRefs: [
        {
          artifactId: "artifact-1",
          kind: "brief",
          uri: pathToFileURL(contextFile).toString(),
        },
      ],
      network: "restricted",
      maxDiskMb: 256,
      ttlMinutes: 30,
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(lease.path, "container-manifest.json"), "utf8"),
    ) as {
      taskId: string;
      tenantId: string;
      network: string;
      maxDiskMb: number;
      ttlMinutes: number;
      mounts: Array<{
        logicalName: string;
        containerPath: string;
        hostPath: string;
        readOnly: boolean;
      }>;
    };

    expect(await fs.readFile(path.join(lease.path, "repo", "README.md"), "utf8")).toContain("# container repo");
    expect(await fs.readFile(path.join(lease.path, "input", "brief.md"), "utf8")).toContain("上下文输入");
    expect(manifest).toMatchObject({
      taskId: "task-container",
      tenantId: "acme",
      network: "restricted",
      maxDiskMb: 256,
      ttlMinutes: 30,
    });
    expect(manifest.mounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logicalName: "input",
          readOnly: true,
        }),
        expect.objectContaining({
          logicalName: "repo",
          readOnly: false,
        }),
        expect.objectContaining({
          logicalName: "output",
          readOnly: false,
        }),
      ]),
    );

    const inputStat = await fs.stat(path.join(lease.path, "input"));
    const outputStat = await fs.stat(path.join(lease.path, "output"));
    expect(inputStat.mode & 0o222).toBe(0);
    expect(outputStat.mode & 0o222).not.toBe(0);

    await lease.cleanup();

    await expect(fs.stat(lease.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
