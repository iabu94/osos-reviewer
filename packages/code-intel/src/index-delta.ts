import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { listChangedFiles as gitListChangedFiles } from "@review/git-manager";
import type { EmbeddingProvider } from "@review/knowledge";
import type { RepoRole } from "@review/shared";
import type { Pool } from "pg";

import { isDiscoverableSourcePath } from "./discover.js";
import { embedSymbols } from "./embed-symbols.js";
import { parseSourceFile } from "./parse.js";
import { isFileCurrent, replaceFileSymbols } from "./store.js";

export interface DeltaIndexReport {
  /** Changed paths (added/modified plus deleted) reported for the PR. */
  filesConsidered: number;
  filesParsed: number;
  filesDeleted: number;
  symbolsUpserted: number;
  filesFailed: number;
}

export type ListChangedFiles = (opts: {
  worktreePath: string;
  targetBranch: string;
}) => Promise<{ addedOrModified: string[]; deleted: string[] }>;

/**
 * Indexes only the files changed on the PR branch into `index_scope = 'pr'`
 * rows tagged with `reviewId`. Baseline rows are never read for writes or
 * deleted. Source files are read from `rootDir` (the worktree checkout root);
 * git is queried at `worktreePath`.
 */
export async function indexPrDelta(opts: {
  pool: Pool;
  repoId: string;
  reviewId: string;
  commitSha: string;
  branchTag: string;
  rootDir: string;
  targetBranch: string;
  worktreePath: string;
  role: RepoRole;
  listChangedFiles?: ListChangedFiles;
  embedder?: EmbeddingProvider;
}): Promise<DeltaIndexReport> {
  const list = opts.listChangedFiles ?? gitListChangedFiles;
  const changed = await list({
    worktreePath: opts.worktreePath,
    targetBranch: opts.targetBranch,
  });
  const report: DeltaIndexReport = {
    filesConsidered: changed.addedOrModified.length + changed.deleted.length,
    filesParsed: 0,
    filesDeleted: 0,
    symbolsUpserted: 0,
    filesFailed: 0,
  };
  const scope = {
    pool: opts.pool,
    repo: opts.repoId,
    indexScope: "pr" as const,
    reviewId: opts.reviewId,
  };

  for (const filePath of new Set(changed.deleted)) {
    if (!isDiscoverableSourcePath(filePath, opts.role)) {
      continue;
    }
    await opts.pool.query(
      `DELETE FROM code_symbols
       WHERE repo = $1 AND index_scope = 'pr' AND review_id = $2 AND file_path = $3`,
      [opts.repoId, opts.reviewId, filePath],
    );
    report.filesDeleted += 1;
  }

  const deleted = new Set(changed.deleted);
  for (const filePath of new Set(changed.addedOrModified)) {
    if (deleted.has(filePath) || !isDiscoverableSourcePath(filePath, opts.role)) {
      continue;
    }
    let sourceBytes: Buffer;
    try {
      sourceBytes = await readFile(join(opts.rootDir, filePath));
    } catch {
      report.filesFailed += 1;
      continue;
    }
    const contentHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (await isFileCurrent({ ...scope, filePath, contentHash })) {
      continue;
    }

    const parsed = parseSourceFile({
      filePath,
      sourceText: sourceBytes.toString("utf8"),
    });
    report.filesParsed += 1;
    if (parsed.errors.length > 0) {
      report.filesFailed += 1;
      if (parsed.symbols.length === 0) {
        continue;
      }
    }

    const embedding = opts.embedder
      ? await embedSymbols(opts.embedder, parsed.symbols)
      : undefined;
    await replaceFileSymbols({
      ...scope,
      commitSha: opts.commitSha,
      branchTag: opts.branchTag,
      filePath,
      contentHash,
      symbols: parsed.symbols,
      relationships: parsed.relationships,
      embedding,
    });
    report.symbolsUpserted += parsed.symbols.length;
  }
  return report;
}
