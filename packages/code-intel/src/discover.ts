import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RepoRole } from "@osos-reviewer/shared";

const ALWAYS_SKIPPED_DIRS = new Set([".git"]);
const SKIPPED_DIRS: Record<RepoRole, Set<string>> = {
  backend: new Set(["bin", "obj"]),
  frontend: new Set(["node_modules", "dist"]),
};

function isSourceFile(name: string, role: RepoRole): boolean {
  if (role === "backend") {
    return name.endsWith(".cs");
  }
  if (name.endsWith(".d.ts")) {
    return false;
  }
  return name.endsWith(".ts") || name.endsWith(".tsx");
}

/** Whether a `/`-separated relative path would be returned by `discoverSourceFiles`. */
export function isDiscoverableSourcePath(
  relativePath: string,
  role: RepoRole,
): boolean {
  const segments = relativePath.split("/");
  const name = segments.pop() ?? "";
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return false;
  }
  for (const segment of segments) {
    if (ALWAYS_SKIPPED_DIRS.has(segment) || SKIPPED_DIRS[role].has(segment)) {
      return false;
    }
  }
  return isSourceFile(name, role);
}

async function walk(
  root: string,
  relativeDir: string,
  role: RepoRole,
  out: string[],
): Promise<void> {
  const entries = await readdir(join(root, relativeDir), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (
        ALWAYS_SKIPPED_DIRS.has(entry.name) ||
        SKIPPED_DIRS[role].has(entry.name)
      ) {
        continue;
      }
      await walk(root, relative, role, out);
    } else if (entry.isFile() && isSourceFile(entry.name, role)) {
      out.push(relative);
    }
  }
}

/** Source files under `rootDir` for the repo role, as sorted `/`-separated relative paths. */
export async function discoverSourceFiles(opts: {
  rootDir: string;
  role: RepoRole;
}): Promise<string[]> {
  const files: string[] = [];
  await walk(resolve(opts.rootDir), "", opts.role, files);
  return files.sort((left, right) => left.localeCompare(right));
}
