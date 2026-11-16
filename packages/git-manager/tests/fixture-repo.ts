import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

async function git(cwd: string, args: string[]) {
  await execa("git", args, { cwd });
}

/** Creates a disposable clone with develop + feature/ABC-123 branches. */
export async function createFixtureRepo(): Promise<{
  repoPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "review-fixture-"));
  const bare = join(root, "remote.git");
  const repoPath = join(root, "clone");

  await execa("git", ["init", "--bare", bare]);
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test"]);
  await writeFile(join(repoPath, "hello.txt"), "hello\n");
  await git(repoPath, ["add", "hello.txt"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await git(repoPath, ["branch", "-M", "develop"]);
  await git(repoPath, ["remote", "add", "origin", bare]);
  await git(repoPath, ["push", "-u", "origin", "develop"]);

  await git(repoPath, ["checkout", "-b", "feature/ABC-123"]);
  await writeFile(join(repoPath, "hello.txt"), "hello\nworld\n");
  await git(repoPath, ["add", "hello.txt"]);
  await git(repoPath, ["commit", "-m", "change"]);
  await git(repoPath, ["push", "-u", "origin", "feature/ABC-123"]);
  await git(repoPath, ["fetch", "origin"]);
  // Leave primary checkout on develop so feature branch is free for worktrees.
  await git(repoPath, ["checkout", "develop"]);

  return {
    repoPath,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
