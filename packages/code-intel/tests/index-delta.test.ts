import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@osos-reviewer/db";
import { FakeEmbeddingProvider } from "@osos-reviewer/knowledge";
import type { RepoConfig } from "@osos-reviewer/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { indexBaseline, indexPrDelta, lookupSymbols } from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "..", "fixtures", "dotnet");
const controllerPath = "OrdersController.cs";

describeWithDatabase("indexPrDelta", () => {
  let pool: ReturnType<typeof createPool>;
  const temps: string[] = [];
  const repo: RepoConfig = {
    id: "be",
    role: "backend",
    localPath: fixtureDotnetRoot,
    defaultBaseBranch: "develop",
  };

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE code_relationships, code_symbols RESTART IDENTITY CASCADE");
    await indexBaseline({
      pool,
      repo,
      commitSha: "base-sha",
      branchTag: "develop",
      rootDir: fixtureDotnetRoot,
    });
  });

  afterEach(async () => {
    while (temps.length) {
      await rm(temps.pop()!, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function prRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "code-intel-pr-"));
    temps.push(root);
    const controller = await readFile(join(fixtureDotnetRoot, controllerPath), "utf8");
    await writeFile(join(root, controllerPath), `${controller}\n// pr edit\n`);
    return root;
  }

  const deltaOpts = (rootDir: string) => ({
    pool,
    repoId: "be",
    reviewId: "rev-1",
    commitSha: "pr-sha",
    branchTag: "feature/ABC-1",
    rootDir,
    targetBranch: "develop",
    worktreePath: rootDir,
    role: "backend" as const,
  });

  it("indexes modified file under review_id without touching baseline", async () => {
    const root = await prRoot();
    const baselineBefore = await lookupSymbols({
      pool,
      repoIds: ["be"],
      indexScope: "baseline",
      nameContains: "Orders",
    });

    const report = await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({ addedOrModified: [controllerPath], deleted: [] }),
    });

    expect(report).toMatchObject({
      filesConsidered: 1,
      filesParsed: 1,
      filesDeleted: 0,
      filesFailed: 0,
    });
    expect(report.symbolsUpserted).toBeGreaterThan(0);

    const baseline = await lookupSymbols({
      pool,
      repoIds: ["be"],
      indexScope: "baseline",
      nameContains: "Orders",
    });
    const pr = await lookupSymbols({
      pool,
      repoIds: ["be"],
      indexScope: "pr",
      reviewId: "rev-1",
      nameContains: "Orders",
    });
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline).toEqual(baselineBefore);
    expect(baseline.every((s) => s.reviewId === null && s.indexScope === "baseline")).toBe(true);
    expect(pr.length).toBeGreaterThan(0);
    expect(pr.every((s) => s.reviewId === "rev-1" && s.commitSha === "pr-sha")).toBe(true);
  });

  it("skips unchanged files, ignores non-source paths, and embeds when asked", async () => {
    const root = await prRoot();
    await writeFile(join(root, "notes.md"), "# hi");
    const list = async () => ({
      addedOrModified: [controllerPath, "notes.md", "bin/Skipped.cs"],
      deleted: [],
    });
    const embedder = new FakeEmbeddingProvider();
    const first = await indexPrDelta({ ...deltaOpts(root), listChangedFiles: list, embedder });
    expect(first.filesConsidered).toBe(3);
    expect(first.filesParsed).toBe(1);
    const missingEmbeddings = await pool.query(
      "SELECT count(*)::int AS n FROM code_symbols WHERE index_scope = 'pr' AND embedding IS NULL",
    );
    expect(missingEmbeddings.rows[0].n).toBe(0);

    const second = await indexPrDelta({ ...deltaOpts(root), listChangedFiles: list });
    expect(second.filesParsed).toBe(0);
    expect(second.symbolsUpserted).toBe(0);
  });

  it("counts unreadable files as failed and continues", async () => {
    const root = await prRoot();
    const report = await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({
        addedOrModified: ["Missing.cs", controllerPath],
        deleted: [],
      }),
    });
    expect(report.filesFailed).toBe(1);
    expect(report.filesParsed).toBe(1);
  });

  it("deleted file removes only PR-scoped symbols", async () => {
    const root = await prRoot();
    await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({ addedOrModified: [controllerPath], deleted: [] }),
    });
    expect(
      (await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", filePaths: [controllerPath] }))
        .length,
    ).toBeGreaterThan(0);

    const report = await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({ addedOrModified: [], deleted: [controllerPath] }),
    });
    expect(report.filesDeleted).toBe(1);

    const pr = await lookupSymbols({
      pool,
      indexScope: "pr",
      reviewId: "rev-1",
      filePaths: [controllerPath],
    });
    const baseline = await lookupSymbols({
      pool,
      indexScope: "baseline",
      filePaths: [controllerPath],
    });
    expect(pr).toEqual([]);
    expect(baseline.length).toBeGreaterThan(0);
  });

  it("does not delete another review's PR rows", async () => {
    const root = await prRoot();
    const list = async () => ({ addedOrModified: [controllerPath], deleted: [] });
    await indexPrDelta({ ...deltaOpts(root), reviewId: "rev-1", listChangedFiles: list });
    await indexPrDelta({ ...deltaOpts(root), reviewId: "rev-2", listChangedFiles: list });
    await indexPrDelta({
      ...deltaOpts(root),
      reviewId: "rev-1",
      listChangedFiles: async () => ({ addedOrModified: [], deleted: [controllerPath] }),
    });
    expect((await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-2" })).length).toBeGreaterThan(0);
  });

  it("clears stale PR symbols when a changed file becomes unparseable", async () => {
    const root = await prRoot();
    await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({ addedOrModified: [controllerPath], deleted: [] }),
    });
    expect(
      (await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", filePaths: [controllerPath] }))
        .length,
    ).toBeGreaterThan(0);

    await writeFile(join(root, controllerPath), "public class Broken { void M( { ]]] ");
    const report = await indexPrDelta({
      ...deltaOpts(root),
      listChangedFiles: async () => ({ addedOrModified: [controllerPath], deleted: [] }),
    });
    expect(report.filesFailed).toBeGreaterThanOrEqual(1);
    expect(
      await lookupSymbols({ pool, indexScope: "pr", reviewId: "rev-1", filePaths: [controllerPath] }),
    ).toEqual([]);
    expect(
      (await lookupSymbols({ pool, indexScope: "baseline", filePaths: [controllerPath] })).length,
    ).toBeGreaterThan(0);
  });

  it("uses git-manager listChangedFiles by default (called with worktree + target)", async () => {
    const root = await prRoot();
    await mkdir(join(root, "x"), { recursive: true });
    const seen: unknown[] = [];
    await indexPrDelta({
      ...deltaOpts(root),
      targetBranch: "develop",
      listChangedFiles: async (o) => {
        seen.push(o);
        return { addedOrModified: [], deleted: [] };
      },
    });
    expect(seen).toEqual([{ worktreePath: root, targetBranch: "develop" }]);
  });
});
