import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { EmbeddingProvider } from "@review/knowledge";
import type { RepoConfig } from "@review/shared";
import type { Pool } from "pg";

import { discoverSourceFiles } from "./discover.js";
import { embedSymbols } from "./embed-symbols.js";
import { parseSourceFile } from "./parse.js";
import {
  deleteBaselineMissingFiles,
  isFileCurrent,
  replaceFileSymbols,
} from "./store.js";

export interface BaselineIndexReport {
  filesSeen: number;
  filesSkippedUnchanged: number;
  filesParsed: number;
  symbolsUpserted: number;
  filesFailed: number;
}

export async function indexBaseline(opts: {
  pool: Pool;
  repo: RepoConfig;
  commitSha: string;
  branchTag: string;
  rootDir: string;
  embedder?: EmbeddingProvider;
}): Promise<BaselineIndexReport> {
  const files = await discoverSourceFiles({
    rootDir: opts.rootDir,
    role: opts.repo.role,
  });
  const report: BaselineIndexReport = {
    filesSeen: files.length,
    filesSkippedUnchanged: 0,
    filesParsed: 0,
    symbolsUpserted: 0,
    filesFailed: 0,
  };
  const scope = {
    pool: opts.pool,
    repo: opts.repo.id,
    indexScope: "baseline" as const,
    reviewId: null,
  };

  for (const filePath of files) {
    const sourceBytes = await readFile(join(opts.rootDir, filePath));
    const contentHash = createHash("sha256").update(sourceBytes).digest("hex");
    if (await isFileCurrent({ ...scope, filePath, contentHash })) {
      report.filesSkippedUnchanged += 1;
      continue;
    }

    const parsed = parseSourceFile({
      filePath,
      sourceText: sourceBytes.toString("utf8"),
    });
    report.filesParsed += 1;
    if (parsed.errors.length > 0) {
      report.filesFailed += 1;
      // Nothing usable was extracted: keep whatever is already indexed.
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

  await deleteBaselineMissingFiles({
    pool: opts.pool,
    repo: opts.repo.id,
    filePaths: files,
  });
  return report;
}
