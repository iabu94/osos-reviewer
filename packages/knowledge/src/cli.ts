#!/usr/bin/env tsx
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPool, migrate } from "@review/db";
import { loadConfig } from "@review/shared";

import { createEmbeddingProvider } from "./embed.js";
import { ingestKnowledgeBase, type IngestReport } from "./ingest.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Ingest only needs the database and embedding settings; default the rest. */
export function withIngestDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    WORKTREE_ROOT: "/tmp/review-worktrees",
    REPOS_JSON: "[]",
    ...env,
  };
}

export async function runIngest(env: NodeJS.ProcessEnv): Promise<IngestReport> {
  const config = loadConfig(withIngestDefaults(env));
  const rootDir = isAbsolute(config.knowledgeBasePath)
    ? config.knowledgeBasePath
    : resolve(env.INIT_CWD ?? REPO_ROOT, config.knowledgeBasePath);
  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool);
    const embedder = createEmbeddingProvider(config.embedding);
    return await ingestKnowledgeBase({ rootDir, pool, embedder });
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;

if (entry && import.meta.url === entry) {
  runIngest(process.env)
    .then((report) => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
