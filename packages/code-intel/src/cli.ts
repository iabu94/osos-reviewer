#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createPool, migrate } from "@osos-reviewer/db";
import { createEmbeddingProvider } from "@osos-reviewer/knowledge";
import { loadConfig } from "@osos-reviewer/shared";
import { config as loadDotenv } from "dotenv";

import { indexBaseline, type BaselineIndexReport } from "./index-baseline.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function parseRepoId(argv: string[]): string {
  const index = argv.indexOf("--repo-id");
  // Positional fallback: PowerShell's npm.ps1 strips a bare `--`, so npm
  // swallows `--repo-id` and only the bare id reaches the script.
  const value =
    index >= 0
      ? argv[index + 1]
      : argv.find((arg) => arg.startsWith("--repo-id="))?.slice("--repo-id=".length) ??
        argv.find((arg) => !arg.startsWith("-"));
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: index-baseline --repo-id <id>");
  }
  return value;
}

export async function runIndexBaseline(
  env: NodeJS.ProcessEnv,
  repoId: string,
): Promise<BaselineIndexReport> {
  const config = loadConfig({ WORKTREE_ROOT: "/tmp/review-worktrees", ...env });
  const repo = config.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new Error(`Unknown repo id "${repoId}"`);
  }
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repo.localPath,
  });
  const commitSha = stdout.trim();

  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    return await indexBaseline({
      pool,
      repo,
      commitSha,
      branchTag: repo.defaultBaseBranch,
      rootDir: repo.localPath,
      embedder: createEmbeddingProvider(config.embedding),
    });
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entry && import.meta.url === entry) {
  loadDotenv({ path: resolve(REPO_ROOT, ".env") });
  Promise.resolve()
    .then(() => runIndexBaseline(process.env, parseRepoId(process.argv.slice(2))))
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
