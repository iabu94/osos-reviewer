import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "./fixture-repo.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { focusedDiff } from "../src/diff.js";

describe("focusedDiff", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("includes hello.txt change with -U2 context against develop", async () => {
    const fixture = await createFixtureRepo();
    cleanups.push(fixture.cleanup);

    const worktreeRoot = await mkdtemp(join(tmpdir(), "diff-root-"));
    cleanups.push(async () => rm(worktreeRoot, { recursive: true, force: true }));

    const { worktreePath } = await createWorktree({
      repoPath: fixture.repoPath,
      worktreeRoot,
      reviewId: "rev-diff",
      repoId: "be",
      branch: "feature/ABC-123",
    });
    cleanups.push(async () =>
      removeWorktree({ repoPath: fixture.repoPath, worktreePath }),
    );

    const diff = await focusedDiff({
      worktreePath,
      targetBranch: "develop",
    });

    expect(diff).toContain("hello.txt");
    expect(diff).toContain("world");
    expect(diff).toMatch(/^diff --git/m);
  });
});
