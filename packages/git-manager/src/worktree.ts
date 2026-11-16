import { mkdir, rm, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

function toRemoteRef(branch: string): string {
  return branch.startsWith("origin/") ? branch : `origin/${branch}`;
}

export async function createWorktree(opts: {
  repoPath: string;
  worktreeRoot: string;
  reviewId: string;
  repoId: string;
  branch: string;
  fetch?: boolean;
}): Promise<{ worktreePath: string; headSha: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.reviewId)) {
    throw new Error(
      `Invalid reviewId "${opts.reviewId}": must match ^[A-Za-z0-9_-]+$`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(opts.repoId)) {
    throw new Error(
      `Invalid repoId "${opts.repoId}": must match ^[A-Za-z0-9_-]+$`,
    );
  }

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

  if (opts.fetch !== false) {
    await execa("git", ["fetch", "--prune", "origin"], {
      cwd: opts.repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
    });
  }

  const ref = toRemoteRef(opts.branch);
  // Detached checkout avoids local branch ownership collisions across concurrent reviews.
  await execa("git", ["worktree", "add", "--detach", worktreePath, ref], {
    cwd: opts.repoPath,
  });

  const { stdout: headSha } = await execa("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
  });

  return { worktreePath, headSha: headSha.trim() };
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

  try {
    await rm(opts.worktreePath, { recursive: true, force: true });
  } catch {
    // best-effort filesystem cleanup
  }

  try {
    await execa("git", ["worktree", "prune"], { cwd: opts.repoPath });
  } catch {
    // ignore prune failures
  }
}
