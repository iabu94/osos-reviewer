import { describe, it, expect, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { createFixtureRepo } from "./fixture-repo.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";
import { focusedDiff, listChangedFiles } from "../src/diff.js";

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

  it("listChangedFiles separates added/modified and deleted files", async () => {
    const fixture = await createFixtureRepo();
    cleanups.push(fixture.cleanup);

    const worktreeRoot = await mkdtemp(join(tmpdir(), "diff-root-"));
    cleanups.push(async () => rm(worktreeRoot, { recursive: true, force: true }));

    const { worktreePath } = await createWorktree({
      repoPath: fixture.repoPath,
      worktreeRoot,
      reviewId: "rev-changed",
      repoId: "be",
      branch: "feature/ABC-123",
    });
    cleanups.push(async () =>
      removeWorktree({ repoPath: fixture.repoPath, worktreePath }),
    );

    // hello.txt is already modified on the branch; add a file and delete another.
    await mkdir(join(worktreePath, "src"), { recursive: true });
    await writeFile(join(worktreePath, "src", "a.ts"), "export const a = 1;\n");
    await execa("git", ["add", "src/a.ts"], { cwd: worktreePath });
    await execa("git", ["rm", "-q", "hello.txt"], { cwd: worktreePath });
    await execa(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-m", "delta"],
      { cwd: worktreePath },
    );

    for (const targetBranch of ["develop", "origin/develop"]) {
      const { addedOrModified, deleted } = await listChangedFiles({
        worktreePath,
        targetBranch,
      });
      expect(addedOrModified).toEqual(["src/a.ts"]);
      expect(deleted).toEqual(["hello.txt"]);
    }
  });

  it("listChangedFiles reports modified files", async () => {
    const fixture = await createFixtureRepo();
    cleanups.push(fixture.cleanup);

    const worktreeRoot = await mkdtemp(join(tmpdir(), "diff-root-"));
    cleanups.push(async () => rm(worktreeRoot, { recursive: true, force: true }));

    const { worktreePath } = await createWorktree({
      repoPath: fixture.repoPath,
      worktreeRoot,
      reviewId: "rev-mod",
      repoId: "be",
      branch: "feature/ABC-123",
    });
    cleanups.push(async () =>
      removeWorktree({ repoPath: fixture.repoPath, worktreePath }),
    );

    const result = await listChangedFiles({ worktreePath, targetBranch: "develop" });
    expect(result).toEqual({ addedOrModified: ["hello.txt"], deleted: [] });
  });
});
