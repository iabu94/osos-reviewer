import {
  createPool,
  ensureDatabase,
  migrate,
  resolveTestDatabaseUrl,
} from "@osos-reviewer/db";
import { FakeEmbeddingProvider } from "@osos-reviewer/knowledge";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  embedSymbols,
  findSimilarSymbols,
  replaceFileSymbols,
  type ParsedSymbol,
} from "../src/index.js";

const databaseUrl = resolveTestDatabaseUrl();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function sym(
  name: string,
  filePath: string,
  signature: string,
  symbolType: ParsedSymbol["symbolType"] = "service",
): ParsedSymbol {
  return { symbolType, symbolName: name, filePath, lineStart: 1, lineEnd: 5, signature };
}

describeWithDatabase("findSimilarSymbols", () => {
  let pool: ReturnType<typeof createPool>;
  const fake = new FakeEmbeddingProvider();

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

  it("returns vector similarity candidates with non-proof explanation", async () => {
    const filePath = "orders.service.ts";
    const symbols = [
      sym("listOrders", filePath, "async list orders from api endpoint"),
      sym("fetchOrders", filePath, "list orders from api with pagination"),
    ];
    const vectors = await embedSymbols(fake, symbols);
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "sha-base",
      branchTag: null,
      filePath,
      contentHash: "h1",
      symbols,
      relationships: [],
      embedding: vectors,
    });

    const hits = await findSimilarSymbols({
      pool,
      embedder: fake,
      query: "list orders from api",
      repoIds: ["be"],
      limit: 3,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].explanation).toMatch(/candidate/i);
    expect(hits[0].explanation).not.toMatch(/confirmed|duplicate proof/i);
    expect(hits[0].explanation).toBe(
      "Vector similarity candidate — verify before treating as duplication.",
    );
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].score).toBeLessThanOrEqual(1);
  });

  it("falls back to name match when embeddings are null", async () => {
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "sha-base",
      branchTag: null,
      filePath: "order.service.ts",
      contentHash: "h2",
      symbols: [sym("OrderService", "order.service.ts", "class OrderService { }")],
      relationships: [],
    });

    const hits = await findSimilarSymbols({
      pool,
      embedder: fake,
      query: "OrderService",
      repoIds: ["be"],
    });

    expect(hits[0]?.explanation).toMatch(/Name\/signature match candidate/i);
    expect(hits[0]?.explanation).toBe(
      "Name/signature match candidate — verify before treating as duplication.",
    );
    expect(hits[0]?.symbolName).toBe("OrderService");
  });

  it("merges baseline and PR scope when reviewId is set", async () => {
    const filePath = "svc.ts";
    const vectors = await embedSymbols(fake, [sym("SharedSvc", filePath, "baseline impl")]);
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "baseline",
      reviewId: null,
      commitSha: "sha-base",
      branchTag: null,
      filePath,
      contentHash: "h-base",
      symbols: [sym("SharedSvc", filePath, "baseline impl")],
      relationships: [],
      embedding: vectors,
    });
    const prVectors = await embedSymbols(fake, [sym("SharedSvc", filePath, "pr impl revised")]);
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "pr",
      reviewId: "rev-merge",
      commitSha: "sha-pr",
      branchTag: null,
      filePath,
      contentHash: "h-pr",
      symbols: [sym("SharedSvc", filePath, "pr impl revised")],
      relationships: [],
      embedding: prVectors,
    });

    const hits = await findSimilarSymbols({
      pool,
      embedder: fake,
      query: "pr impl revised",
      repoIds: ["be"],
      reviewId: "rev-merge",
      limit: 5,
    });

    expect(hits.some((h) => h.symbolName === "SharedSvc" && h.signature === "pr impl revised")).toBe(
      true,
    );
    expect(hits.some((h) => h.signature === "baseline impl")).toBe(false);
  });

  it("returns empty for pr scope without reviewId", async () => {
    await replaceFileSymbols({
      pool,
      repo: "be",
      indexScope: "pr",
      reviewId: "rev-1",
      commitSha: "sha-pr",
      branchTag: null,
      filePath: "a.ts",
      contentHash: "h3",
      symbols: [sym("X", "a.ts", "x")],
      relationships: [],
    });

    expect(
      await findSimilarSymbols({
        pool,
        embedder: fake,
        query: "x",
        indexScope: "pr",
      }),
    ).toEqual([]);
  });
});