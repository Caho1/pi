import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileSystemWorkspaceManager } from "../apps/agent-worker/src/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("git-worktree workspace", () => {
  const runtimeRoot = "runtime/test-workspace-git-worktree";

  afterEach(async () => {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  });

  test("git-worktree 模式会创建独立 worktree 并在清理时回收", async () => {
    const repoRoot = path.resolve(runtimeRoot, "source-repo");
    await fs.mkdir(repoRoot, { recursive: true });

    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "Codex Test"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "codex@example.com"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "# demo\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoRoot });

    const manager = new FileSystemWorkspaceManager(runtimeRoot);
    const lease = await manager.prepare({
      taskId: "task-git-worktree",
      tenantId: "acme",
      mode: "git-worktree",
      retainOnFailure: false,
      sourceRepoPath: repoRoot,
    });

    const worktreeRepoPath = path.join(lease.path, "repo");
    const readme = await fs.readFile(path.join(worktreeRepoPath, "README.md"), "utf8");
    expect(readme).toContain("# demo");

    const insideWorktree = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: worktreeRepoPath,
    });
    expect(insideWorktree.stdout.trim()).toBe("true");

    const worktreeListBeforeCleanup = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
    });
    expect(worktreeListBeforeCleanup.stdout).toContain(worktreeRepoPath);

    await lease.cleanup();

    const worktreeListAfterCleanup = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
    });
    expect(worktreeListAfterCleanup.stdout).not.toContain(worktreeRepoPath);
  });
});
