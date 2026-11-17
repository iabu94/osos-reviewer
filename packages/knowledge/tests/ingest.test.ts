import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createEmbeddingProvider,
  EmptyDiscoveryError,
  FakeEmbeddingProvider,
  ingestKnowledgeBase,
  type EmbeddingProvider,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const quiet = (): void => undefined;

async function writeDoc(
  root: string,
  relativePath: string,
  contents: string,
): Promise<string> {
  const absolutePath = join(root, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
  return absolutePath;
}

describeWithDatabase("ingestKnowledgeBase", () => {
  let pool: ReturnType<typeof createPool>;
  let root: string;
  const embedder = createEmbeddingProvider({
    provider: "fake",
    model: "fake",
    dimensions: 768,
  });

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE document_chunks");
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
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
    const absolutePath = await writeDoc(
      root,
      relativePath,
      "# Components\n\nPrefer OnPush change detection.\n",
    );
    // A second doc keeps discovery non-empty after the first is deleted.
    await writeDoc(root, "security/secure.md", "# Secure\n\nValidate input.\n");

    const first = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder,
      warn: quiet,
    });
    const firstCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    const second = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder,
      warn: quiet,
    });
    const secondCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    await unlink(absolutePath);
    const third = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder,
      warn: quiet,
    });
    const finalCount = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );

    expect(first.chunksUpserted).toBeGreaterThanOrEqual(
      Number(firstCount.rows[0].count),
    );
    expect(second.documentsSkippedUnchanged).toBe(2);
    expect(secondCount.rows[0].count).toBe(firstCount.rows[0].count);
    expect(third.chunksDeleted).toBe(Number(firstCount.rows[0].count));
    expect(finalCount.rows[0].count).toBe("0");
  });

  it("modified document: changed section replaced, unchanged section keeps its row", async () => {
    const relativePath = "coding-standards/angular/components.md";
    await writeDoc(
      root,
      relativePath,
      "# Components\n\n## Change detection\n\nPrefer OnPush change detection.\n\n## Templates\n\nAvoid logic in templates.\n",
    );
    await ingestKnowledgeBase({ rootDir: root, pool, embedder, warn: quiet });

    type Row = { id: string; section: string; chunk_text: string };
    const snapshot = async (): Promise<Row[]> =>
      (
        await pool.query<Row>(
          "SELECT id::text, section, chunk_text FROM document_chunks WHERE source_path = $1 ORDER BY section",
          [relativePath],
        )
      ).rows;

    const before = await snapshot();
    expect(before.map((row) => row.section)).toEqual([
      "Change detection",
      "Templates",
    ]);
    const unchangedBefore = before.find((r) => r.section === "Change detection")!;
    const changedBefore = before.find((r) => r.section === "Templates")!;

    await writeDoc(
      root,
      relativePath,
      "# Components\n\n## Change detection\n\nPrefer OnPush change detection.\n\n## Templates\n\nKeep templates declarative and free of business logic.\n",
    );
    const report = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder,
      warn: quiet,
    });

    const after = await snapshot();
    expect(report.documentsSkippedUnchanged).toBe(0);
    expect(report.chunksDeleted).toBeGreaterThanOrEqual(1);
    expect(after).toHaveLength(2);
    const unchangedAfter = after.find((r) => r.section === "Change detection")!;
    expect(unchangedAfter.id).toBe(unchangedBefore.id);
    expect(after.some((r) => r.id === changedBefore.id)).toBe(false);
    expect(after.some((r) => r.chunk_text === changedBefore.chunk_text)).toBe(
      false,
    );
    expect(
      after.find((r) => r.section === "Templates")!.chunk_text,
    ).toContain("business logic");
  });

  it("re-embeds an unchanged document when the embedding model changes", async () => {
    const relativePath = "security/secure.md";
    await writeDoc(root, relativePath, "# Secure\n\nValidate all input.\n");
    await ingestKnowledgeBase({ rootDir: root, pool, embedder, warn: quiet });

    const otherModel: EmbeddingProvider = {
      dimensions: 768,
      modelId: "fake:other-model",
      embed: (texts) => new FakeEmbeddingProvider().embed(texts),
    };
    const report = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder: otherModel,
      warn: quiet,
    });

    const { rows } = await pool.query<{ embedding_model: string }>(
      "SELECT DISTINCT embedding_model FROM document_chunks WHERE source_path = $1",
      [relativePath],
    );
    expect(report.documentsSkippedUnchanged).toBe(0);
    expect(rows).toEqual([{ embedding_model: "fake:other-model" }]);

    const again = await ingestKnowledgeBase({
      rootDir: root,
      pool,
      embedder: otherModel,
      warn: quiet,
    });
    expect(again.documentsSkippedUnchanged).toBe(1);
  });

  it("refuses to wipe the index when discovery finds no documents", async () => {
    await writeDoc(root, "security/secure.md", "# Secure\n\nValidate input.\n");
    await ingestKnowledgeBase({ rootDir: root, pool, embedder, warn: quiet });
    const populated = await pool.query<{ count: string }>(
      "SELECT count(*) FROM document_chunks",
    );
    expect(Number(populated.rows[0].count)).toBeGreaterThan(0);

    const emptyRoot = await mkdtemp(join(tmpdir(), "review-ingest-empty-"));
    try {
      const warnings: string[] = [];
      await writeDoc(emptyRoot, "notes/readme.md", "# Notes\n");
      await expect(
        ingestKnowledgeBase({
          rootDir: emptyRoot,
          pool,
          embedder,
          warn: (message) => warnings.push(message),
        }),
      ).rejects.toBeInstanceOf(EmptyDiscoveryError);
      expect(warnings.some((message) => message.includes('"notes"'))).toBe(
        true,
      );

      const afterRefuse = await pool.query<{ count: string }>(
        "SELECT count(*) FROM document_chunks",
      );
      expect(afterRefuse.rows[0].count).toBe(populated.rows[0].count);

      const forced = await ingestKnowledgeBase({
        rootDir: emptyRoot,
        pool,
        embedder,
        allowEmpty: true,
        warn: quiet,
      });
      expect(forced.skippedTopLevel).toEqual(["notes"]);
      expect(forced.chunksDeleted).toBe(Number(populated.rows[0].count));
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
