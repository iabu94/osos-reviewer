import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@review/db";
import { FakeEmbeddingProvider } from "@review/knowledge";
import type { RepoConfig } from "@review/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  indexBaseline,
  isFileCurrent,
  replaceFileSymbols,
  type ParsedRelationship,
  type ParsedSymbol,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDotnetRoot = join(here, "..", "fixtures", "dotnet");

const file = "src/Foo.cs";

function sym(name: string, symbolType: ParsedSymbol["symbolType"] = "endpoint"): ParsedSymbol {
  return {
    symbolType,
    symbolName: name,
    filePath: file,
    lineStart: 1,
    lineEnd: 2,
    signature: `sig ${name}`,
  };
}

describeWithDatabase("code store", () => {
  let pool: ReturnType<typeof createPool>;
  const embedder = new FakeEmbeddingProvider();
  const base = () => ({
    pool,
    repo: "backend",
    indexScope: "baseline" as const,
    reviewId: null,
    commitSha: "abc123",
    branchTag: "develop",
    filePath: file,
    contentHash: "hash1",
  });

  beforeAll(async () => {
    await ensureDatabase(databaseUrl!);
    pool = createPool(databaseUrl!);
    await migrate(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE code_relationships, code_symbols RESTART IDENTITY CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("replaceFileSymbols removes stale symbols on reindex", async () => {
    await replaceFileSymbols({ ...base(), symbols: [sym("Foo")], relationships: [] });
    await replaceFileSymbols({
      ...base(),
      contentHash: "hash2",
      symbols: [sym("Bar")],
      relationships: [],
    });
    const rows = await pool.query(
      "SELECT symbol_name, content_hash FROM code_symbols WHERE file_path = $1",
      [file],
    );
    expect(rows.rows.map((r) => r.symbol_name)).toEqual(["Bar"]);
    expect(rows.rows[0].content_hash).toBe("hash2");
  });

  it("resolves relationship targets in batch and leaves others unresolved", async () => {
    const relationships: ParsedRelationship[] = [
      { sourceName: "A", sourceType: "controller", targetName: "B", relationshipType: "calls", filePath: file, lineStart: 3 },
      { sourceName: "A", sourceType: "controller", targetName: "External", relationshipType: "references", filePath: file, lineStart: 4 },
    ];
    await replaceFileSymbols({
      ...base(),
      symbols: [sym("A", "controller"), sym("B", "service_method")],
      relationships,
    });
    const rows = await pool.query(
      `SELECT r.target_name, r.target_symbol_id, t.symbol_name AS target_symbol, s.symbol_name AS source
       FROM code_relationships r
       JOIN code_symbols s ON s.id = r.source_symbol_id
       LEFT JOIN code_symbols t ON t.id = r.target_symbol_id
       ORDER BY r.line_start`,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ source: "A", target_symbol: "B" });
    expect(rows.rows[1]).toMatchObject({ target_symbol_id: null, target_name: "External" });
  });

  it("resolves targets from symbols already in the DB for the scope", async () => {
    await replaceFileSymbols({
      ...base(),
      filePath: "src/Other.cs",
      symbols: [{ ...sym("Other", "dto"), filePath: "src/Other.cs" }],
      relationships: [],
    });
    await replaceFileSymbols({
      ...base(),
      symbols: [sym("A", "controller")],
      relationships: [
        { sourceName: "A", sourceType: "controller", targetName: "Other", relationshipType: "references", filePath: file, lineStart: 1 },
      ],
    });
    const rows = await pool.query(
      "SELECT t.symbol_name FROM code_relationships r JOIN code_symbols t ON t.id = r.target_symbol_id",
    );
    expect(rows.rows.map((r) => r.symbol_name)).toEqual(["Other"]);
  });

  it("resolves dotted sources by class prefix and skips unresolvable sources", async () => {
    await replaceFileSymbols({
      ...base(),
      symbols: [sym("OrderService", "angular_service")],
      relationships: [
        { sourceName: "OrderService.list", sourceType: "service_method", targetName: "GET /orders", relationshipType: "http_calls", filePath: file, lineStart: 5 },
        { sourceName: "Missing.go", sourceType: "service_method", targetName: "GET /x", relationshipType: "http_calls", filePath: file, lineStart: 6 },
      ],
    });
    const rows = await pool.query(
      "SELECT s.symbol_name, r.target_name FROM code_relationships r JOIN code_symbols s ON s.id = r.source_symbol_id",
    );
    expect(rows.rows).toEqual([{ symbol_name: "OrderService", target_name: "GET /orders" }]);
  });

  it("stores embeddings aligned with symbols", async () => {
    const [v] = await embedder.embed(["hello"]);
    await replaceFileSymbols({
      ...base(),
      symbols: [sym("A"), sym("B")],
      relationships: [],
      embedding: [v, null],
    });
    const rows = await pool.query(
      "SELECT symbol_name, embedding IS NOT NULL AS has FROM code_symbols ORDER BY symbol_name",
    );
    expect(rows.rows).toEqual([
      { symbol_name: "A", has: true },
      { symbol_name: "B", has: false },
    ]);
  });

  it("isFileCurrent matches on content hash within scope", async () => {
    const key = { pool, repo: "backend", indexScope: "baseline" as const, reviewId: null, filePath: file };
    expect(await isFileCurrent({ ...key, contentHash: "hash1" })).toBe(false);
    await replaceFileSymbols({ ...base(), symbols: [sym("A")], relationships: [] });
    expect(await isFileCurrent({ ...key, contentHash: "hash1" })).toBe(true);
    expect(await isFileCurrent({ ...key, contentHash: "other" })).toBe(false);
    expect(await isFileCurrent({ ...key, repo: "frontend", contentHash: "hash1" })).toBe(false);
    expect(
      await isFileCurrent({ ...key, indexScope: "pr", reviewId: "r1", contentHash: "hash1" }),
    ).toBe(false);
  });

  describe("indexBaseline", () => {
    const repo = (localPath: string): RepoConfig => ({
      id: "backend",
      role: "backend",
      localPath,
      defaultBaseBranch: "develop",
    });

    it("skips unchanged content_hash", async () => {
      const opts = {
        pool,
        repo: repo(fixtureDotnetRoot),
        commitSha: "sha1",
        branchTag: "develop",
        rootDir: fixtureDotnetRoot,
        embedder,
      };
      const r1 = await indexBaseline(opts);
      expect(r1.filesParsed).toBeGreaterThan(0);
      expect(r1.symbolsUpserted).toBeGreaterThan(0);
      const embedded = await pool.query("SELECT count(*)::int AS n FROM code_symbols WHERE embedding IS NULL");
      expect(embedded.rows[0].n).toBe(0);

      const r2 = await indexBaseline(opts);
      expect(r2.filesSkippedUnchanged).toBeGreaterThan(0);
      expect(r2.symbolsUpserted).toBe(0);
      expect(r2.filesFailed).toBe(0);
    });

    it("continues after one unparseable file and removes deleted files", async () => {
      const root = await mkdtemp(join(tmpdir(), "code-intel-mixed-"));
      try {
        await mkdir(join(root, "src"), { recursive: true });
        const { readFile } = await import("node:fs/promises");
        const controller = await readFile(join(fixtureDotnetRoot, "OrdersController.cs"), "utf8");
        await writeFile(join(root, "src", "OrdersController.cs"), controller);
        await writeFile(join(root, "src", "broken.cs"), "public class Broken { void M( { ]]] ");
        await writeFile(join(root, "src", "Gone.cs"), "public class GoneDto { public int Id { get; set; } }");
        const opts = {
          pool,
          repo: repo(root),
          commitSha: "sha1",
          branchTag: "develop",
          rootDir: root,
        };
        const report = await indexBaseline(opts);
        expect(report.filesFailed).toBeGreaterThanOrEqual(1);
        expect(report.symbolsUpserted).toBeGreaterThan(0);
        let paths = await pool.query("SELECT DISTINCT file_path FROM code_symbols ORDER BY 1");
        expect(paths.rows.map((r) => r.file_path)).toContain("src/Gone.cs");

        await rm(join(root, "src", "Gone.cs"));
        await indexBaseline({ ...opts, commitSha: "sha2" });
        paths = await pool.query("SELECT DISTINCT file_path FROM code_symbols ORDER BY 1");
        expect(paths.rows.map((r) => r.file_path)).not.toContain("src/Gone.cs");
        expect(paths.rows.map((r) => r.file_path)).toContain("src/OrdersController.cs");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("clears stale symbols when a file becomes unparseable", async () => {
      const root = await mkdtemp(join(tmpdir(), "code-intel-stale-"));
      try {
        await mkdir(join(root, "src"), { recursive: true });
        const { readFile } = await import("node:fs/promises");
        const dto = await readFile(join(fixtureDotnetRoot, "OrderDto.cs"), "utf8");
        await writeFile(join(root, "src", "OrderDto.cs"), dto);
        const opts = {
          pool,
          repo: repo(root),
          commitSha: "sha1",
          branchTag: "develop",
          rootDir: root,
        };
        await indexBaseline(opts);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM code_symbols WHERE file_path = $1",
              ["src/OrderDto.cs"],
            )
          ).rows[0].n,
        ).toBeGreaterThan(0);

        await writeFile(join(root, "src", "OrderDto.cs"), "public class OrderDto { void M( { ]]] ");
        const report = await indexBaseline({ ...opts, commitSha: "sha2" });
        expect(report.filesFailed).toBeGreaterThanOrEqual(1);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM code_symbols WHERE file_path = $1",
              ["src/OrderDto.cs"],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
