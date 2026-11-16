import { mkdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

export async function createWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  reviewId: string;
  repoId: string;
  branch: string;
}): Promise<{ worktreePath: string }> {
  const worktreePath = join(opts.worktreeRoot, opts.reviewId, opts.repoId);
  await mkdir(dirname(worktreePath), { recursive: true });

  try {
    await access(worktreePath);
    await removeWorktree({
      repoPath: opts.repoPath,
      worktreePath,
    });
  } catch {
    // path does not exist yet
  }

  await execa(
    "git",
    ["worktree", "add", "-B", opts.branch, worktreePath, opts.branch],
    { cwd: opts.repoPath },
  );

  return { worktreePath };
}

export async function removeWorktree(opts: {
  repoPath: string;
  worktreePath: string;
}): Promise<void> {
  try {
    await execa(
      "git",
      ["worktree", "remove", "--force", opts.worktreePath],
      { cwd: opts.repoPath },
    );
  } catch {
    // already removed from git's perspective
  }

  await rm(opts.worktreePath, { recursive: true, force: true });

  try {
    await execa("git", ["worktree", "prune"], { cwd: opts.repoPath });
  } catch {
    // ignore prune failures
  }
}
