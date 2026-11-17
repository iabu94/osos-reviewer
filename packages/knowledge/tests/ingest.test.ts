import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPool, migrate } from "@review/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createEmbeddingProvider,
  ingestKnowledgeBase,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("ingestKnowledgeBase", () => {
  const pool = createPool(databaseUrl!);
  let root: string;

  beforeAll(async () => {
    await migrate(pool);
    await pool.query("TRUNCATE document_chunks");
    root = await mkdtemp(join(tmpdir(), "review-ingest-"));
  });

  afterAll(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    await pool.query("TRUNCATE document_chunks");
    await pool.end();
  });

  it("reingesting unchanged docs skips duplicates; deleting a file removes chunks", async () => {
    const relativePath = "coding-standards/angular/components.md";
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(
      absolutePath,
      "# Components\n\nPrefer OnPush change detection.\n",
      "utf8",
    );
    const embedder = createEmbeddingProvider({
      provider: "fake",
      model: "fake",
      dimensions: 768,
    });

    const first = await ingestKnowledgeBase({ rootDir: root, pool, embedder });
    const firstCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    const second = await ingestKnowledgeBase({ rootDir: root, pool, embedder });
    const secondCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    await unlink(absolutePath);
    const third = await ingestKnowledgeBase({ rootDir: root, pool, embedder });
    const finalCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    expect(first.chunksUpserted).toBe(Number(firstCount.rows[0].count));
    expect(second.documentsSkippedUnchanged).toBe(1);
    expect(secondCount.rows[0].count).toBe(firstCount.rows[0].count);
    expect(third.chunksDeleted).toBe(Number(firstCount.rows[0].count));
    expect(finalCount.rows[0].count).toBe("0");
  });
});
