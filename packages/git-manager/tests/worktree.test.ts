import { describe, it, expect, afterEach } from "vitest";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "./fixture-repo.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";

describe("worktree", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("creates isolated paths per repoId and remove is idempotent", async () => {
    const a = await createFixtureRepo();
    const b = await createFixtureRepo();
    cleanups.push(a.cleanup, b.cleanup);

    const worktreeRoot = await mkdtemp(join(tmpdir(), "wt-root-"));
    cleanups.push(async () => {
      const { rm } = await import("node:fs/promises");
      await rm(worktreeRoot, { recursive: true, force: true });
    });

    const reviewId = "rev-1";
    const wtA = await createWorktree({
      repoPath: a.repoPath,
      worktreeRoot,
      reviewId,
      repoId: "be",
      branch: "feature/ABC-123",
    });
    const wtB = await createWorktree({
      repoPath: b.repoPath,
      worktreeRoot,
      reviewId,
      repoId: "fe",
      branch: "feature/ABC-123",
    });

    expect(wtA.worktreePath.endsWith(join(reviewId, "be"))).toBe(true);
    expect(wtB.worktreePath.endsWith(join(reviewId, "fe"))).toBe(true);
    expect(wtA.worktreePath).not.toBe(wtB.worktreePath);

    await removeWorktree({
      repoPath: a.repoPath,
      worktreePath: wtA.worktreePath,
    });
    await expect(access(wtA.worktreePath)).rejects.toThrow();
    await expect(
      removeWorktree({
        repoPath: a.repoPath,
        worktreePath: wtA.worktreePath,
      }),
    ).resolves.toBeUndefined();

    await removeWorktree({
      repoPath: b.repoPath,
      worktreePath: wtB.worktreePath,
    });
  });
});
