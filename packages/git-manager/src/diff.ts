import { execa } from "execa";

function normalizeTarget(targetBranch: string): string {
  return targetBranch.startsWith("origin/") ? targetBranch : `origin/${targetBranch}`;
}

export async function focusedDiff(opts: {
  worktreePath: string;
  targetBranch: string;
}): Promise<string> {
  const target = normalizeTarget(opts.targetBranch);

  const { stdout } = await execa(
    "git",
    ["diff", `${target}...HEAD`, "-U2"],
    { cwd: opts.worktreePath },
  );
  return stdout;
}

/** Paths changed on HEAD relative to the merge base with the target branch. */
export async function listChangedFiles(opts: {
  worktreePath: string;
  targetBranch: string;
}): Promise<{ addedOrModified: string[]; deleted: string[] }> {
  const target = normalizeTarget(opts.targetBranch);
  const names = async (filter: string): Promise<string[]> => {
    const { stdout } = await execa(
      "git",
      ["diff", "--name-only", `--diff-filter=${filter}`, `${target}...HEAD`],
      { cwd: opts.worktreePath },
    );
    return stdout.split("\n").filter((line) => line.length > 0);
  };
  const [addedOrModified, deleted] = await Promise.all([
    names("ACMR"),
    names("D"),
  ]);
  return { addedOrModified, deleted };
}
