#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";

import { createPool, migrate } from "@review/db";
import { loadConfig } from "@review/shared";

import { createEmbeddingProvider } from "./embed.js";
import { ingestKnowledgeBase, type IngestReport } from "./ingest.js";
import { resolveKnowledgeBasePath } from "./paths.js";

/** Ingest only needs the database and embedding settings; default the rest. */
export function withIngestDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    WORKTREE_ROOT: "/tmp/review-worktrees",
    REPOS_JSON: "[]",
    ...env,
  };
}

export async function runIngest(
  env: NodeJS.ProcessEnv,
  options: { allowEmpty?: boolean } = {},
): Promise<IngestReport> {
  const config = loadConfig(withIngestDefaults(env));
  const rootDir = resolveKnowledgeBasePath(config.knowledgeBasePath);
  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    const embedder = createEmbeddingProvider(config.embedding);
    return await ingestKnowledgeBase({
      rootDir,
      pool,
      embedder,
      allowEmpty: options.allowEmpty,
    });
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entry && import.meta.url === entry) {
  runIngest(process.env, {
    allowEmpty: process.argv.slice(2).includes("--force-empty"),
  })
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
