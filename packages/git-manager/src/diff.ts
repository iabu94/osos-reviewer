import { execa } from "execa";

export async function focusedDiff(opts: {
  worktreePath: string;
  targetBranch: string;
}): Promise<string> {
  const target = opts.targetBranch.startsWith("origin/")
    ? opts.targetBranch
    : `origin/${opts.targetBranch}`;

  const { stdout } = await execa(
    "git",
    ["diff", `${target}...HEAD`, "-U2"],
    { cwd: opts.worktreePath },
  );
  return stdout;
}
